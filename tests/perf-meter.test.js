import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerfMeter } from '../src/lib/perf-meter.js';

test('frame meter reports rolling cadence, peak and draw cost', () => {
  const meter = createPerfMeter({ windowMs: 2000 });
  assert.equal(meter.out.text, '');

  for (let frame = 0; frame <= 50; frame++) meter.tick(frame * 40);
  assert.ok(Math.abs(meter.out.fps - 25) < 0.05);
  assert.equal(meter.out.intervalMs, 40);
  assert.equal(meter.out.peakMs, 40);
  assert.equal(meter.out.frames, 50);
  assert.ok(meter.out.text.includes('帧率 25'));
  assert.ok(meter.out.text.includes('峰值 40ms'));

  meter.cost(6.4, 2000);
  meter.cost(2.8, 2040);
  assert.ok(meter.out.renderMs > 2 && meter.out.renderMs < 7);
  assert.equal(meter.out.renderPeakMs, 6.4);

  for (let frame = 51; frame <= 60; frame++) meter.tick(frame * 40);
  meter.tick(2500 + 120);
  assert.ok(meter.out.peakMs >= 120 && meter.out.fps < 25, 'a long frame lowers FPS and raises the peak');
});

test('frame meter ignores suspend-sized gaps and resets cleanly', () => {
  const meter = createPerfMeter({ windowMs: 500 });
  for (let frame = 0; frame <= 20; frame++) meter.tick(frame * 40);
  const before = meter.out.fps;
  meter.tick(2000 + 5000);
  assert.equal(meter.out.fps, before, 'a five second suspend is not reported as a game frame');
  meter.tick(7040);
  assert.equal(meter.out.intervalMs, 40);

  meter.reset();
  assert.equal(meter.out.text, '');
  assert.equal(meter.out.frames, 0);
  meter.tick(8040);
  assert.equal(meter.out.text, '', 'one frame cannot establish a rate');
  meter.tick(8080);
  assert.ok(meter.out.fps >= 20);
  assert.equal(meter.tick(NaN), meter.out);
});
