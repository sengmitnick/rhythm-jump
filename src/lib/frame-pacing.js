// Frame pacing for the 480x352 native stage. Ask the host for its display
// cadence, start at 60 fps, and use sustained render cost (not a single GC
// spike) to step down to 45 or 30 fps when the device is under load.
export const TARGET_FPS = 60;
export const MIN_FPS = 30;
export const MIN_INTERVAL_MS = 1000 / TARGET_FPS;
export const MAX_INTERVAL_MS = 1000 / MIN_FPS;
export const FRAME_INTERVALS_MS = Object.freeze([1000 / 60, 1000 / 45, 1000 / 30]);

export class FramePacer {
  constructor() { this.reset(); }

  reset() {
    this.level = 0;
    this.intervalMs = FRAME_INTERVALS_MS[0];
    this.costMs = 0;
    this.samples = 0;
    this.cooldown = 0;
    this.highLoadSamples = 0;
    this.lowLoadSamples = 0;
  }

  observe(costMs) {
    if (!Number.isFinite(costMs) || costMs < 0) return this.intervalMs;
    this.costMs = this.samples === 0 ? costMs : this.costMs * 0.85 + costMs * 0.15;
    this.samples++;
    const overloaded = this.costMs > this.intervalMs * 0.70;
    const recoverable = this.level > 0 && this.costMs < FRAME_INTERVALS_MS[this.level - 1] * 0.48;
    this.highLoadSamples = overloaded ? this.highLoadSamples + 1 : 0;
    this.lowLoadSamples = recoverable ? this.lowLoadSamples + 1 : 0;
    if (this.cooldown > 0) {
      this.cooldown--;
      return this.intervalMs;
    }

    // Six sustained expensive frames are enough to protect the next tier.
    // Recovery is intentionally slower so alternating work/GC frames do not
    // make the target cadence bounce while a recording is active.
    if (this.highLoadSamples >= 6 && this.level < FRAME_INTERVALS_MS.length - 1) {
      this.level++;
      this.intervalMs = FRAME_INTERVALS_MS[this.level];
      this.highLoadSamples = 0; this.lowLoadSamples = 0;
      this.cooldown = 8;
    } else if (this.lowLoadSamples >= 45 && this.level > 0) {
      this.level--;
      this.intervalMs = FRAME_INTERVALS_MS[this.level];
      this.highLoadSamples = 0; this.lowLoadSamples = 0;
      this.cooldown = 24;
    }
    return this.intervalMs;
  }
}

// Frames are dropped by skipping the draw, never by stretching game time: the
// chart clock stays wall-clock based so late frames cannot slow the music.
export function shouldDrawFrame(nowMs, nextFrameAtMs) {
  return !(nowMs + 1 < nextFrameAtMs);
}
