// Frame pacing for the 480x352 native stage. The host delivers display callbacks
// at an unknown cadence, so the page asks for 60 fps and backs off when a frame
// costs too much. Recording the screen roughly doubles the paint cost, which is
// exactly when the old fixed 30 fps budget collapsed.
export const TARGET_FPS = 60;
export const MIN_FPS = 24;
export const MIN_INTERVAL_MS = 1000 / TARGET_FPS;
export const MAX_INTERVAL_MS = 1000 / MIN_FPS;

// One step per call; the caller applies it at most once per frame. A frame that
// eats more than half its budget widens the interval, an idle frame narrows it.
// Both directions are bounded so the loop cannot oscillate between extremes.
export function nextFrameInterval(currentMs, costMs) {
  const current = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : MIN_INTERVAL_MS;
  const cost = Number.isFinite(costMs) && costMs >= 0 ? costMs : 0;
  if (cost > current * 0.5) return Math.min(MAX_INTERVAL_MS, current * 1.25);
  if (cost < current * 0.2) return Math.max(MIN_INTERVAL_MS, current * 0.9);
  return current;
}

// Frames are dropped by skipping the draw, never by stretching game time: the
// chart clock stays wall-clock based so late frames cannot slow the music.
export function shouldDrawFrame(nowMs, nextFrameAtMs) {
  return !(nowMs + 1 < nextFrameAtMs);
}
