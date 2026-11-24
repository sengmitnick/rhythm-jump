// Frame-rate meter used by the native stage, modelled on the one in
// 「突出重围」. It reports the cadence the app actually achieved: interval
// between game callbacks, the peak interval in the current window and the time
// spent inside the JavaScript frame including Canvas submission.
//
// This is an app-side measurement. The optical panel may still refresh
// differently; the on-screen readout is evidence for A/B comparisons, not a
// certified display refresh rate.
const DEFAULT_WINDOW_MS = 2000;
const DEFAULT_CAPACITY = 180;

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function createPerfMeter({ windowMs = DEFAULT_WINDOW_MS, capacity = DEFAULT_CAPACITY } = {}) {
  const intervals = new Float64Array(capacity);
  const intervalEnds = new Float64Array(capacity);
  const renderCosts = new Float64Array(capacity);
  const renderEnds = new Float64Array(capacity);
  let intervalIndex = 0, intervalCount = 0;
  let renderIndex = 0, renderCount = 0;
  let lastAt = -1;

  const out = {
    fps: 0, intervalMs: 0, peakMs: 0, renderMs: 0, renderPeakMs: 0, frames: 0, text: '',
  };

  function reset(now = null) {
    intervalIndex = 0; intervalCount = 0;
    renderIndex = 0; renderCount = 0;
    lastAt = Number.isFinite(now) ? now : -1;
    out.fps = 0; out.intervalMs = 0; out.peakMs = 0;
    out.renderMs = 0; out.renderPeakMs = 0; out.frames = 0; out.text = '';
  }

  function summarize() {
    if (!intervalCount) return;
    let total = 0, peak = 0, used = 0, renderTotal = 0, renderPeak = 0, renderUsed = 0;
    const newest = intervalEnds[(intervalIndex - 1 + capacity) % capacity];
    for (let i = 0; i < intervalCount; i++) {
      const position = (intervalIndex - 1 - i + capacity * 2) % capacity;
      if (newest - intervalEnds[position] > windowMs) break;
      const value = intervals[position];
      total += value;
      if (value > peak) peak = value;
      used++;
    }
    for (let i = 0; i < renderCount; i++) {
      const position = (renderIndex - 1 - i + capacity * 2) % capacity;
      if (newest - renderEnds[position] > windowMs) break;
      const value = renderCosts[position];
      renderTotal += value;
      if (value > renderPeak) renderPeak = value;
      renderUsed++;
    }
    if (!used) return;
    const mean = total / used;
    out.intervalMs = round1(mean);
    out.fps = round1(1000 / mean);
    out.peakMs = Math.round(peak);
    out.frames = used;
    if (renderUsed) {
      out.renderMs = round1(renderTotal / renderUsed);
      out.renderPeakMs = round1(renderPeak);
    }
    const text = `帧率 ${Math.round(out.fps)} · 间隔 ${out.intervalMs.toFixed(1)}ms · 峰值 ${out.peakMs}ms · 绘制 ${out.renderMs.toFixed(1)}ms`;
    if (text !== out.text) out.text = text;
  }

  // Call once per game frame with the frame start time.
  function tick(now) {
    if (!Number.isFinite(now)) return out;
    if (lastAt < 0) { lastAt = now; return out; }
    const delta = now - lastAt;
    lastAt = now;
    // Ignore clock jumps and long suspension windows rather than reporting them
    // as a game stutter after the page was hidden.
    if (!(delta > 0) || delta > 2000) return out;
    intervals[intervalIndex] = delta;
    intervalEnds[intervalIndex] = now;
    intervalIndex = (intervalIndex + 1) % capacity;
    if (intervalCount < capacity) intervalCount++;
    summarize();
    return out;
  }

  // Call after Canvas flush with the measured update + draw cost.
  function cost(ms, now = null) {
    if (!Number.isFinite(ms) || ms < 0) return out;
    const at = Number.isFinite(now) ? now : lastAt;
    renderCosts[renderIndex] = ms;
    renderEnds[renderIndex] = at;
    renderIndex = (renderIndex + 1) % capacity;
    if (renderCount < capacity) renderCount++;
    summarize();
    return out;
  }

  reset();
  return { out, tick, cost, reset };
}
