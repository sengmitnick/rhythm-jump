// Client for the Lingzhu rhythm leaderboard workflow.
//
// The workflow is stateless: every request is a JSON string in the agent's
// `question` field and the final answer is one JSON object streamed back as
// `step: content` fragments. Nothing here writes to storage or logs the
// account profile.
export const PROTOCOL_VERSION = 'rhythm-jump/1';
export const DEFAULT_AGENT_ID = '';
const END_REPLY_GRACE_MS = 1500;

export class LeaderboardError extends Error {
  constructor(code, message, retryable = false) {
    super(message || code || 'leaderboard_error');
    this.name = 'LeaderboardError';
    this.code = code || 'LEADERBOARD_ERROR';
    this.retryable = !!retryable;
  }
}

function randomToken(prefix) {
  const cryptoObject = typeof crypto !== 'undefined' ? crypto : null;
  const uuid = cryptoObject && typeof cryptoObject.randomUUID === 'function'
    ? cryptoObject.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + '_' + uuid;
}

export function buildEnvelope({ op, data = {}, actor, requestId }) {
  return {
    v: PROTOCOL_VERSION,
    request_id: requestId,
    actor: { id: String(actor?.id || ''), name: String(actor?.name || '玩家').slice(0, 24) },
    op,
    data,
  };
}

function variableOutput(payload) {
  const metadata = payload?.message?.metadata;
  const candidates = [
    payload?.output,
    payload?.data?.output,
    metadata?.output?.data,
    metadata?.output,
    metadata?.data,
    metadata?.response_json,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      if (candidate.v === PROTOCOL_VERSION) return JSON.stringify(candidate);
      const inner = candidate.output ?? candidate.response_json;
      if (typeof inner === 'string' && inner.trim()) return inner;
      if (inner && typeof inner === 'object') return JSON.stringify(inner);
    }
  }
  return '';
}

export function parseAgentReply(text, expectedRequestId = null) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LeaderboardError('EMPTY_REPLY', '排行榜没有返回内容');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // A workflow may present its JSON with a Markdown fence around it.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new LeaderboardError('BAD_REPLY', '排行榜返回格式异常');
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new LeaderboardError('BAD_REPLY', '排行榜返回格式异常');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LeaderboardError('BAD_REPLY', '排行榜返回格式异常');
  }
  // The Lingzhu bot wraps the End node's response_json as {"output":"..."}.
  // Unwrap one level so the client sees the protocol envelope.
  const wrapped = value.output ?? value.response_json;
  if (typeof wrapped === 'string') {
    try {
      const inner = JSON.parse(wrapped);
      if (inner && typeof inner === 'object') value = inner;
    } catch { /* keep the original for a clear protocol error */ }
  } else if (wrapped && typeof wrapped === 'object') {
    value = wrapped;
  }
  if (value.v !== PROTOCOL_VERSION) {
    throw new LeaderboardError('UNSUPPORTED_VERSION', '排行榜协议版本不匹配');
  }
  if (expectedRequestId && value.request_id && value.request_id !== expectedRequestId) {
    throw new LeaderboardError('BAD_REPLY', '排行榜回包与请求不匹配');
  }
  if (value.ok !== true) {
    const error = value.error || {};
    throw new LeaderboardError(error.code || 'REJECTED', error.message || '排行榜请求失败', error.retryable);
  }
  return value.data || {};
}

export class LeaderboardClient {
  constructor({
    createOpenAPI, agentId = DEFAULT_AGENT_ID, timeoutMs = 15000,
    randomId = randomToken, now = () => Date.now(),
  } = {}) {
    this.createOpenAPI = createOpenAPI;
    this.agentId = String(agentId || '');
    this.timeoutMs = timeoutMs;
    this.randomId = randomId;
    this.now = now;
    this._api = null;
    this._actor = null;
    this._userSynced = false;
    this._conversationId = String(randomId('conv')).replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'rhythm';
    this._conversationId = this._conversationId || 'rhythm';
  }

  get configured() { return typeof this.createOpenAPI === 'function' && !!this.agentId; }

  async _openapi() {
    if (!this.configured) throw new LeaderboardError('NOT_CONFIGURED', '排行榜后端未配置');
    if (!this._api) {
      this._api = Promise.resolve(this.createOpenAPI()).then(api => {
        if (!api || !api.agent || typeof api.agent.invokeAgentApi !== 'function') {
          throw new LeaderboardError('NOT_CONFIGURED', '当前宿主不支持灵珠智能体');
        }
        return api;
      });
    }
    return this._api;
  }

  async profile() {
    if (this._actor) return this._actor;
    const api = await this._openapi();
    if (!api.account || typeof api.account.getProfile !== 'function') {
      throw new LeaderboardError('NO_ACCOUNT', '当前宿主没有账号信息');
    }
    const profile = await api.account.getProfile();
    const actor = {
      id: String(profile?.accountId || ''),
      name: String(profile?.userName || '玩家').slice(0, 24),
    };
    if (!actor.id) throw new LeaderboardError('NO_ACCOUNT', '未登录，无法上榜');
    this._actor = actor;
    return actor;
  }

  async ensureUser() {
    if (this._userSynced) return;
    try {
      const actor = await this.profile();
      await this.request('user.upsert', { display_name: actor.name }, { actor });
      this._userSynced = true;
    } catch (error) {
      // The score row carries its own display-name snapshot; a failed user row
      // must not block a legitimate score.
      if (error?.code === 'NO_ACCOUNT' || error?.code === 'NOT_CONFIGURED') throw error;
      console.warn('[rhythm] leaderboard user sync', String(error?.message || error));
    }
  }

  async submitScore({ songId, chartVersion, runId, score, maxCombo, perfect, good, ok = 0, miss }) {
    if (!this.configured) throw new LeaderboardError('NOT_CONFIGURED', '排行榜后端未配置');
    await this.ensureUser();
    return this.request('score.submit', {
      song_id: String(songId),
      chart_version: Number(chartVersion),
      run_id: String(runId),
      score: Number(score),
      max_combo: Number(maxCombo),
      perfect: Number(perfect),
      // The existing workflow stores all non-Perfect hits in its Good field.
      good: Number(good) + Number(ok),
      miss: Number(miss),
    });
  }

  async fetchLeaderboard({ songId, chartVersion, limit = 8 }) {
    return this.request('leaderboard.list', {
      song_id: String(songId),
      chart_version: Number(chartVersion),
      limit: Math.max(1, Math.min(20, Number(limit) || 8)),
    });
  }

  request(op, data, { actor = null } = {}) {
    const requestId = this.randomId('req');
    return new Promise((resolve, reject) => {
      let settled = false;
      let content = '';
      let finalAnswer = '';
      let workflowAnswer = '';
      let lastShape = null;
      let workflowShape = null;
      let stream = null;
      let timer = null;
      let endTimer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (endTimer !== null) { clearTimeout(endTimer); endTimer = null; }
        try { stream?.close?.(); } catch { /* stream cleanup is best effort */ }
        fn(value);
      };
      const fail = error => finish(reject, error instanceof LeaderboardError
        ? error : new LeaderboardError('NETWORK_ERROR', String(error?.message || error), true));
      const tryReply = () => {
        const answers = new Set([content, finalAnswer, workflowAnswer].filter(answer => answer.trim()));
        let error;
        for (const answer of answers) {
          try { finish(resolve, parseAgentReply(answer, requestId)); return null; }
          catch (failure) { error ??= failure; }
        }
        return error || new LeaderboardError('EMPTY_REPLY', '排行榜没有返回内容');
      };

      timer = setTimeout(() => fail(new LeaderboardError('TIMEOUT', '排行榜请求超时', true)), this.timeoutMs);
      (async () => {
        try {
          const me = actor || await this.profile();
          const envelope = buildEnvelope({ op, data, actor: me, requestId });
          const api = await this._openapi();
          stream = api.agent.invokeAgentApi({
            body: {
              conversation_id: this._conversationId,
              agent_id: this.agentId,
              question: JSON.stringify(envelope),
            },
          });
          if (!stream || typeof stream !== 'object') {
            throw new LeaderboardError('NO_STREAM', '排行榜没有返回数据流');
          }
          stream.onerror = () => {
            if(endTimer === null) fail(new LeaderboardError('NETWORK_ERROR', '排行榜连接中断', true));
          };
          stream.onmessage = event => {
            if (settled) return;
            const type = event?.type;
            let payload = null;
            try {
              payload = event?.data ? (typeof event.data === 'string' ? JSON.parse(event.data) : event.data) : null;
            } catch { payload = null; }
            if (payload) {
              const metadata = payload.message?.metadata;
              const output = metadata?.output;
              lastShape = {
                type, step: payload.step || null, status: payload.status || null,
                agentId: payload.agent_id || null,
                serial: payload.serial_number ?? null,
                messageKeys: Object.keys(payload.message || {}).slice(0, 8),
                metadataKeys: Object.keys(metadata || {}).slice(0, 8),
                outputKeys: typeof output === 'object' ? Object.keys(output || {}).slice(0, 8) : [],
                contentLength: typeof payload.message?.content === 'string' ? payload.message.content.length : 0,
                finalLength: typeof payload.message?.final_answer === 'string' ? payload.message.final_answer.length : 0,
              };
              if (lastShape.metadataKeys.length) workflowShape = lastShape;
              const outputText = variableOutput(payload);
              if (outputText) workflowAnswer = outputText;
            }
            if (payload?.message && (!payload.step || payload.step === 'content')) {
              if (typeof payload.message.content === 'string' && payload.message.content) {
                content += payload.message.content;
              } else if (payload.message.content && typeof payload.message.content === 'object') {
                content += JSON.stringify(payload.message.content);
              }
              // Some hosts deliver the complete text only in final_answer on
              // the end event. Prefer concatenated content, but keep a fallback.
              if (typeof payload.message.final_answer === 'string' && payload.message.final_answer) {
                finalAnswer = payload.message.final_answer;
              } else if (payload.message.final_answer && typeof payload.message.final_answer === 'object') {
                finalAnswer = JSON.stringify(payload.message.final_answer);
              }
            }
            if (type === 'error') {
              const message = payload?.message?.content || '排行榜请求失败';
              fail(new LeaderboardError('AGENT_ERROR', String(message), false));
              return;
            }
            const isEnd = (type === 'end' || type === 'done') && !(payload?.step === 'action' && payload.status !== 'finish');
            if (!isEnd && endTimer === null && payload?.status !== 'finish') return;
            if (!tryReply() || !isEnd || endTimer !== null) return;
            // A real-device request can receive an empty end before the workflow writes its reply.
            endTimer = setTimeout(() => {
              const error = tryReply();
              if (!error) return;
              console.warn('[rhythm] leaderboard invalid stream ' + JSON.stringify({op,requestId,code:error.code,last:lastShape,workflow:workflowShape}));
              fail(error);
            }, END_REPLY_GRACE_MS);
          };
        } catch (error) {
          fail(error);
        }
      })();
    });
  }
}

export function createLeaderboardClient(options) {
  return new LeaderboardClient(options);
}
