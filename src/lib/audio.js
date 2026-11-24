// Recorded and synthesized soundtrack. Gameplay owns its monotonic clock; this
// module reports native playback submission timing so Session can align chart
// zero without letting an output clock change judgement time.
const SCALE = [0, 3, 5, 7, 10];

// Engineering starting point, not a device measurement: four roughly 20 ms
// native bridge/decode/mixer/output scheduling quanta. Device video or loopback
// evidence must tune this per host; the trace records the synchronous part too.
export const DEFAULT_AUDIO_OFFSET_MS = 80;
const MAX_AUDIO_OFFSET_MS = 500;

export function normalizeAudioOffsetMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_AUDIO_OFFSET_MS;
  return Math.max(0, Math.min(MAX_AUDIO_OFFSET_MS, value));
}

function disposePlayer(player) {
  try { player.stop(); } catch { /* already stopped */ }
  try { player.destroy(); } catch { /* already released */ }
}

export class RhythmAudio {
  constructor(Context, AudioPlayer = null, { clock = null, audioOffsetMs } = {}) {
    this.Context = Context; this.AudioPlayer = AudioPlayer;
    this.clock = typeof clock === 'function' ? clock : () => performance.now();
    this.audioOffsetMs = normalizeAudioOffsetMs(audioOffsetMs);
    this.context = null; this.lastBeat = -1; this.volume = 0.17;
    this.voices = []; this.voiceIndex = 0; this.root = 220; this.mood = 0; this.lastCountdown = -1;
    this.trackSrc = null; this.trackLoop = false; this.trackDurationMs = 0; this.player = null;
    this.preview = null; this.playbackTiming = null;
  }
  // A course may carry its own recording. Its authored bars define the beat
  // grid, while Session keeps the chart on the shared monotonic clock.
  setCourse(course) {
    this.stopPreview();
    const src = course?.music || null;
    const loop = course?.loopMusic === true;
    if (src !== this.trackSrc || loop !== this.trackLoop) this.stopMusic();
    this.trackSrc = src;
    this.trackLoop = loop;
    this.trackDurationMs = course?.musicDurationMs || 0;
    this.root = course?.root || 220;
    // Lower root and longer level read as "calmer" so the three courses do not
    // sound identical even though they share one synthesizer.
    this.mood = course?.id === 'stretch' ? 0 : course?.id === 'step' ? 1 : 2;
    this.lastBeat = -1;
  }
  async prepare() {
    if (this.trackSrc && this.AudioPlayer && !this.player) {
      try {
        const player = new this.AudioPlayer();
        this.player = player;
        player.loop = this.trackLoop;
        player.onError?.(() => this.stopMusic(player));
        player.src = this.trackSrc;
      } catch { this.stopMusic(); }
    }
    if (!this.context && this.Context) {
      this.context = new this.Context();
      // Reuse six voices. Native Web Audio has a bounded graph and does not
      // guarantee browser-style onended delivery for releasing one-shot nodes.
      for (let i = 0; i < 6; i++) {
        const o = this.context.createOscillator(), g = this.context.createGain();
        g.gain.value = 0; o.connect(g); g.connect(this.context.destination); o.start();
        this.voices.push({ o, g });
      }
    }
    if (this.context?.state === 'suspended') await this.context.resume();
  }
  now() {
    // Recorded courses use the monotonic clock, even if native playback fails
    // after a chart has started and the synth needs to take over.
    if (this.trackSrc && this.AudioPlayer) return this.clock();
    return this.context ? this.context.currentTime * 1000 : this.clock();
  }
  startMusic(positionMs = 0) {
    this.stopPreview();
    const player = this.player;
    if (!player) return null;
    const seekMs = this.trackLoop && this.trackDurationMs > 0 ? positionMs % this.trackDurationMs : positionMs;
    // Mark both sides of the native bridge. `submittedAtMs` excludes synchronous
    // seek/play cost from the chart, while audioOffsetMs estimates the remaining
    // decoder/output delay before the first sample is actually audible.
    const requestedAtMs = this.now();
    try {
      player.seek(Math.max(0, seekMs) / 1000);
      if (this.player !== player) return null;
      const pending = player.play();
      const submittedAtMs = this.now();
      const timing = this.playbackTiming = {
        requestedAtMs,
        submittedAtMs,
        commandMs: Math.max(0, submittedAtMs - requestedAtMs),
        audioOffsetMs: this.audioOffsetMs,
        estimatedAudibleAtMs: submittedAtMs + this.audioOffsetMs,
        positionMs: Math.max(0, seekMs),
      };
      pending?.catch?.(() => this.stopMusic(player));
      return timing;
    } catch {
      this.stopMusic(player);
      return null;
    }
  }
  stopMusic(player = this.player) {
    if (!player || this.player !== player) return;
    // prepare() will recreate the decoder if the round resumes.
    this.player = null; this.playbackTiming = null;
    disposePlayer(player);
  }
  startPreview(course) {
    this.stopPreview();
    if (!this.AudioPlayer || !course?.previewMusic || !(course.previewDurationMs > 0)) return false;
    this.stopMusic();
    try {
      const player = new this.AudioPlayer();
      this.preview = { player, startedAt: this.clock(), durationMs: course.previewDurationMs };
      const release = () => this.stopPreview(player);
      player.loop = false;
      player.onEnded?.(release);
      player.onError?.(release);
      player.src = course.previewMusic;
      if (this.preview?.player === player) player.play()?.catch?.(release);
      return this.preview?.player === player;
    } catch {
      this.stopPreview();
      return false;
    }
  }
  stopPreview(player = this.preview?.player) {
    if (!player || this.preview?.player !== player) return;
    this.preview = null;
    disposePlayer(player);
  }
  previewState() {
    if (this.preview) {
      const elapsedMs = this.clock() - this.preview.startedAt;
      if (elapsedMs < this.preview.durationMs) {
        return { playing: true, progress: elapsedMs / this.preview.durationMs };
      }
      this.stopPreview();
    }
    return { playing: false, progress: 0 };
  }
  tone(freq, duration = 0.09, type = 'sine', volume = 1, when = null) {
    const c = this.context; if (!c || !this.voices.length) return;
    if (this.volume <= 0) {
      for (const { g } of this.voices) { g.gain.cancelScheduledValues(c.currentTime); g.gain.setValueAtTime(0, c.currentTime); }
      return;
    }
    const t = when ?? c.currentTime; const { o, g } = this.voices[this.voiceIndex++ % this.voices.length];
    o.type = type; o.frequency.value = freq; g.gain.cancelScheduledValues(c.currentTime);
    g.gain.setValueAtTime(0.001, c.currentTime);
    g.gain.setValueAtTime(Math.max(0.001, this.volume * volume), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    g.gain.setValueAtTime(0, t + duration + 0.001);
  }
  // One call per beat: kick, hat, bass and an arpeggio that opens up as the
  // combo grows and the level reaches its climax section.
  tick(elapsed, bpm, combo = 0, section = 0) {
    // With a recording there is nothing to synthesize: it would fight the track.
    if (this.player) return;
    const beatMs = 60000 / bpm; const beat = Math.floor(elapsed / beatMs);
    if (beat === this.lastBeat) return; this.lastBeat = beat;
    const bar = Math.floor(beat / 4), step = beat % 4;
    const root = this.root, climax = section >= 2;
    if (step % 2 === 0) this.tone(root * 0.28, 0.12, 'sine', 1.3);
    this.tone(root * 4.4, 0.022, 'square', 0.05);
    if (step === 0) this.tone(root * 0.5, 0.2, 'triangle', 0.5);
    const degree = SCALE[(beat + bar + this.mood) % SCALE.length];
    const octave = combo >= 16 ? 4 : 2;
    this.tone(root * Math.pow(2, degree / 12) * octave, 0.1, 'triangle', combo >= 8 ? 0.22 : 0.14);
    if (climax && step === 2) this.tone(root * 3, 0.045, 'square', 0.07);
    if (combo >= 24 && step === 3) this.tone(root * 5, 0.03, 'square', 0.05);
  }
  countdown(seconds) {
    if (seconds === this.lastCountdown) return; this.lastCountdown = seconds;
    if (seconds > 0) this.tone(this.root * 2, 0.08, 'sine', 0.5);
  }
  // Layer a fast click and a short body at the same instant as the hit. The
  // compact decay leaves room for the recording and closely spaced cues.
  feedback(grade, combo = 0) {
    const lift = Math.min(12, combo) * 18;
    if (grade === 'perfect') {
      this.tone(1450 + lift, 0.036, 'triangle', 2.1);
      this.tone(400 + lift / 4, 0.075, 'sine', 1.2);
    } else if (grade === 'good') {
      this.tone(670 + lift, 0.064, 'sine', 1.1);
    } else if (grade === 'ok') {
      this.tone(470 + lift / 2, 0.05, 'sine', 0.8);
    } else if (grade === 'miss') {
      this.tone(140, 0.16, 'sine', 0.8);
    }
  }
  async suspend() { if (this.context?.state === 'running') await this.context.suspend(); }
  async close() {
    this.stopPreview();
    this.stopMusic();
    for (const { o, g } of this.voices) { o.stop(); o.disconnect(); g.disconnect(); }
    this.voices = []; this.voiceIndex = 0;
    if (this.context) { await this.context.close(); this.context = null; } this.lastBeat = -1;
  }
}
