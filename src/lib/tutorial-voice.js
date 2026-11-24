const RETRY_DELAY_MS = 120;
const RETRY_LIFETIME_MS = 1600;

export class TutorialVoice {
  constructor({
    synthesis = typeof speechSynthesis === 'undefined' ? null : speechSynthesis,
    Utterance = typeof SpeechSynthesisUtterance === 'undefined' ? null : SpeechSynthesisUtterance,
    Player = typeof SpeechAudioPlayer === 'undefined' ? null : SpeechAudioPlayer,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = timer => clearTimeout(timer),
  } = {}) {
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.Player = Player;
    this.schedule = schedule;
    this.cancel = cancel;
    this.request = null;
  }

  retry() {
    if (this.request || typeof this.synthesis?.synthesize !== 'function' ||
        typeof this.Utterance !== 'function' || typeof this.Player !== 'function') return false;
    const request = {
      delay: null, expiry: null, task: null, player: null, ready: false, started: false,
      controller: typeof AbortController === 'function' ? new AbortController() : null,
    };
    this.request = request;
    request.delay = this.schedule(() => {
      request.delay = null;
      this.playWhenReady(request);
    }, RETRY_DELAY_MS);
    request.expiry = this.schedule(() => this.stop(request), RETRY_LIFETIME_MS);
    this.prepare(request);
    return true;
  }

  async prepare(request) {
    try {
      const utterance = new this.Utterance('再试一下');
      utterance.voice = 'female-tianmei';
      const task = await this.synthesis.synthesize(utterance, { signal: request.controller?.signal });
      request.task = task;
      task.finished.catch(() => this.stop(request));
      if (request !== this.request) {
        if (task.state === 'running') task.abort();
        return;
      }
      const player = new this.Player(task, { trackMode: 'hidden' });
      request.player = player;
      const ready = () => {
        request.ready = true;
        this.playWhenReady(request);
      };
      const audio = player.audioPlayer;
      audio?.onEnded?.(() => this.stop(request));
      audio?.onError?.(() => this.stop(request));
      if (typeof audio?.onCanplay === 'function') audio.onCanplay(ready);
      else ready();
    } catch { this.stop(request); }
  }

  playWhenReady(request) {
    if (request !== this.request || request.delay !== null || !request.ready || request.started) return;
    request.started = true;
    try { request.player.play(); }
    catch { this.stop(request); }
  }

  stop(request = this.request) {
    if (!request || request !== this.request) return;
    this.request = null;
    if (request.delay !== null) this.cancel(request.delay);
    if (request.expiry !== null) this.cancel(request.expiry);
    try {
      if (request.controller) request.controller.abort();
      else if (request.task?.state === 'running') request.task.abort();
    } catch { /* the synthesis host may already be closing */ }
    try { request.player?.stop(); } catch { /* already stopped */ }
    try { request.player?.destroy(); } catch { /* already released */ }
  }
}
