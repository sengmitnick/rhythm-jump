import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaderboardClient, buildEnvelope, parseAgentReply } from '../src/lib/leaderboard-client.js';

function streamOf(events) {
  const stream = {
    closed: false,
    close() { this.closed = true; },
  };
  queueMicrotask(() => {
    for (const event of events) stream.onmessage?.(event);
  });
  return stream;
}

function fakeApi(handler, profile = { accountId: 'u1', userName: '小林' }) {
  return {
    account: { getProfile: async () => profile },
    agent: {
      invokeAgentApi: ({ body }) => {
        const request = JSON.parse(body.question);
        return streamOf(handler(request, body));
      },
    },
  };
}

function okEvent(request, data, split = false, prefix = '') {
  const value = prefix + JSON.stringify({ v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data, error: null });
  if (!split) return [{ type: 'data', data: JSON.stringify({ step: 'content', message: { content: value } }) }, { type: 'end', data: '' }];
  const middle = Math.floor(value.length / 2);
  return [
    { type: 'data', data: JSON.stringify({ step: 'content', message: { content: value.slice(0, middle) } }) },
    { type: 'data', data: JSON.stringify({ step: 'content', message: { content: value.slice(middle) } }) },
    { type: 'end', data: '' },
  ];
}

function client(api, options = {}) {
  let counter = 0;
  return new LeaderboardClient({
    createOpenAPI: async () => api,
    agentId: 'agent_test',
    randomId: prefix => `${prefix}_${++counter}`,
    ...options,
  });
}

test('envelope and reply parsing keep the protocol strict', () => {
  const envelope = buildEnvelope({
    op: 'score.submit',
    data: { song_id: 'party-full' },
    actor: { id: 'u1', name: '小林' },
    requestId: 'req_1',
  });
  assert.equal(envelope.v, 'rhythm-jump/1');
  assert.equal(envelope.actor.id, 'u1');
  assert.equal(envelope.actor.name, '小林');

  const reply = parseAgentReply('```json\n{"v":"rhythm-jump/1","request_id":"r","ok":true,"data":{"me":{"position":1}}}\n```', 'r');
  assert.equal(reply.me.position, 1);
  const wrapped = JSON.stringify({ output: JSON.stringify({ v: 'rhythm-jump/1', request_id: 'r2', ok: true, data: { me: { position: 2 } }, error: null }) });
  assert.equal(parseAgentReply(wrapped, 'r2').me.position, 2, 'bot output wrapper is unwrapped');
  assert.throws(() => parseAgentReply('', 'r'), error => error.code === 'EMPTY_REPLY');
  assert.throws(() => parseAgentReply('{"v":"other","ok":true}', 'r'), error => error.code === 'UNSUPPORTED_VERSION');
  assert.throws(() => parseAgentReply('{"v":"rhythm-jump/1","ok":false,"error":{"code":"DB_ERROR"}}', 'r'),
    error => error.code === 'DB_ERROR' && error.retryable === false);
});

test('submitScore syncs the user once and reads rank from a split text-prefixed reply', async () => {
  const calls = [];
  let upserts = 0;
  const api = fakeApi((request, body) => {
    calls.push({ request, body });
    if (request.op === 'user.upsert') {
      upserts++;
      return okEvent(request, { user: { user_id: 'u1', display_name: '小林' } });
    }
    return okEvent(request, {
      song_id: 'party-full', song_title: 'Party Sector · 完整', chart_version: 3,
      entries: [{ position: 1, is_me: 1, display_name: '小林', score: 65000 }],
      me: { position: 1, score: 65000 }, total_players: 1,
      submitted: { position: 1, score: 65000, is_best: 1 },
    }, true, 'RHYTHM_RESULT\n');
  });
  const board = client(api);
  const data = await board.submitScore({
    songId: 'party-full', chartVersion: 3, runId: 'run_1', score: 65000,
    maxCombo: 40, perfect: 60, good: 10, miss: 24,
  });
  assert.equal(data.submitted.position, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.op, 'user.upsert');
  assert.equal(calls[1].request.op, 'score.submit');
  assert.equal(calls[1].request.data.perfect + calls[1].request.data.good + calls[1].request.data.miss, 94);
  assert.equal(calls[0].body.agent_id, 'agent_test');
  assert.equal(calls[0].body.conversation_id, calls[1].body.conversation_id);
  assert.equal(upserts, 1);

  await board.submitScore({ songId: 'party-full', chartVersion: 3, runId: 'run_2', score: 63500, maxCombo: 30, perfect: 59, good: 8, ok: 2, miss: 25 });
  assert.equal(upserts, 1, 'the user row is not written on every score');
  assert.equal(calls.at(-1).request.data.good, 10, 'the legacy wire field includes OK hits');
  assert.equal(calls.at(-1).request.data.score, 63500, 'OK still receives its own point value');
});

test('an end event whose answer is only in final_answer still parses', async () => {
  const api = fakeApi(request => {
    const answer = JSON.stringify({ v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data: { me: { position: 3, score: 1 } }, error: null });
    return [{ type: 'end', data: JSON.stringify({ step: 'content', status: 'finish', message: { content: null, final_answer: answer } }) }];
  });
  const board = client(api);
  const data = await board.fetchLeaderboard({ songId: 'party-full', chartVersion: 3 });
  assert.equal(data.me.position, 3);
});

test('a partial content fragment falls back to the complete final_answer', async () => {
  const api = fakeApi(request => {
    const answer = JSON.stringify({ v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data: { me: { position: 5 } }, error: null });
    return [
      { type: 'data', data: JSON.stringify({ step: 'content', message: { content: answer.slice(0, 20) } }) },
      { type: 'end', data: JSON.stringify({ step: 'content', status: 'finish', message: { content: null, final_answer: answer } }) },
    ];
  });
  const data = await client(api).fetchLeaderboard({ songId: 'party-full', chartVersion: 3 });
  assert.equal(data.me.position, 5);
});

test('a workflow end variable in message.metadata.output is used', async () => {
  const api = fakeApi(request => {
    const answer = { v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data: { me: { position: 4 } }, error: null };
    return [{ type: 'end', data: JSON.stringify({ step: 'content', status: 'finish', message: { content: null, metadata: { output: JSON.stringify(answer) } } }) }];
  });
  const data = await client(api).fetchLeaderboard({ songId: 'party-full', chartVersion: 3 });
  assert.equal(data.me.position, 4);
});

test('leaderboard JSON sent as text is read from the data event before an empty end', async () => {
  const api = fakeApi(request => {
    const answer = { v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data: { entries: [{ score: 8750 }] } };
    return [
      { type: 'data', data: JSON.stringify({ step: 'content', status: 'streaming', message: { content: `RHYTHM_RESULT\n${JSON.stringify(answer)}` } }) },
      { type: 'end', data: JSON.stringify({ step: 'content', status: 'finish', message: { content: null, final_answer: null } }) },
    ];
  });
  const data = await client(api).fetchLeaderboard({ songId: 'beatucada', chartVersion: 1 });
  assert.equal(data.entries[0].score, 8750);
});

test('an empty end waits for the later leaderboard reply', async () => {
  const api = fakeApi(request => {
    const answer = JSON.stringify({ v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data: { entries: [{ score: 8750 }] } });
    return [
      { type: 'end', data: JSON.stringify({ step: 'content', status: 'finish', message: { content: null, final_answer: null } }) },
      { type: 'data', data: JSON.stringify({ step: 'content', message: { content: answer.slice(0, 20) } }) },
      { type: 'data', data: JSON.stringify({ step: 'content', message: { content: answer.slice(20) } }) },
    ];
  });
  const data = await client(api).fetchLeaderboard({ songId: 'beatucada', chartVersion: 1 });
  assert.equal(data.entries[0].score, 8750);
});

test('tool result survives the later empty text end and thought is ignored', async () => {
  const api = fakeApi(request => {
    const answer = { v: 'rhythm-jump/1', request_id: request.request_id, ok: true, data: { entries: [], total_players: 0 } };
    return [
      { type: 'data', data: JSON.stringify({ step: 'thought', message: { content: '{internal}' } }) },
      { type: 'end', data: JSON.stringify({ step: 'action', status: 'tool_call_finish', message: { metadata: { output: { data: answer } } } }) },
      { type: 'end', data: JSON.stringify({ step: 'content', status: 'finish', message: { content: null } }) },
    ];
  });
  const data = await client(api).fetchLeaderboard({ songId: 'beatucada', chartVersion: 1 });
  assert.deepEqual(data, { entries: [], total_players: 0 });
});

test('fetchLeaderboard works without writing a user row', async () => {
  const ops = [];
  const api = fakeApi(request => {
    ops.push(request.op);
    return okEvent(request, {
      song_id: 'party-full', song_title: 'Party Sector · 完整', chart_version: 3,
      entries: [], me: null, total_players: 0,
    });
  });
  const board = client(api);
  const data = await board.fetchLeaderboard({ songId: 'party-full', chartVersion: 3, limit: 8 });
  assert.equal(data.entries.length, 0);
  assert.deepEqual(ops, ['leaderboard.list']);
});

test('a missing profile fails with NO_ACCOUNT and a timed-out stream rejects', async () => {
  const board = client(fakeApi(() => [], { accountId: '', userName: '' }));
  await assert.rejects(board.fetchLeaderboard({ songId: 'party-full', chartVersion: 3 }), error => error.code === 'NO_ACCOUNT');

  const slow = new LeaderboardClient({
    createOpenAPI: async () => ({ account: { getProfile: async () => ({ accountId: 'u1', userName: '小林' }) }, agent: { invokeAgentApi: () => ({ close() {} }) } }),
    agentId: 'agent_test', timeoutMs: 20, randomId: prefix => `${prefix}_1`,
  });
  await assert.rejects(slow.fetchLeaderboard({ songId: 'party-full', chartVersion: 3 }), error => error.code === 'TIMEOUT');
});

test('agent errors and a failed user sync preserve the score path', async () => {
  const api = fakeApi(request => {
    if (request.op === 'user.upsert') {
      return [{ type: 'error', data: JSON.stringify({ message: { content: '用户表暂不可用' } }) }];
    }
    return okEvent(request, { entries: [], me: null, total_players: 0, submitted: { position: null } });
  });
  const board = client(api);
  const data = await board.submitScore({ songId: 'party-full', chartVersion: 3, runId: 'run_3', score: 0, maxCombo: 0, perfect: 0, good: 0, miss: 94 });
  assert.equal(data.submitted.position, null);
});
