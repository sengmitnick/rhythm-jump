import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FramePacer, FRAME_INTERVALS_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS, shouldDrawFrame,
} from '../src/lib/frame-pacing.js';

test('frame pacing starts at 60 fps and stays inside the 45 fps floor', () => {
  const pacer = new FramePacer();
  assert.equal(pacer.intervalMs, 1000 / 60);
  assert.equal(MIN_INTERVAL_MS, 1000 / 60);
  assert.equal(MAX_INTERVAL_MS, 1000 / 45);
  assert.deepEqual(FRAME_INTERVALS_MS, [1000 / 60, 1000 / 45]);
});

test('sustained load steps down to 45 fps and never below it', () => {
  const pacer = new FramePacer();
  for (let i = 0; i < 60; i++) pacer.observe(25);
  assert.equal(pacer.intervalMs, 1000 / 45);
  for (let i = 0; i < 200; i++) pacer.observe(400);
  assert.equal(pacer.intervalMs, MAX_INTERVAL_MS);
});

test('one expensive frame cannot downshift and recovery uses long hysteresis', () => {
  const pacer = new FramePacer();
  for (let i = 0; i < 20; i++) pacer.observe(2);
  pacer.observe(100);
  assert.equal(pacer.intervalMs, MIN_INTERVAL_MS, 'a GC spike is not sustained load');
  for (let i = 0; i < 80; i++) pacer.observe(25);
  assert.equal(pacer.intervalMs, MAX_INTERVAL_MS);
  for (let i = 0; i < 20; i++) pacer.observe(1);
  assert.equal(pacer.intervalMs, MAX_INTERVAL_MS, 'short idle bursts do not oscillate upward');
  for (let i = 0; i < 240; i++) pacer.observe(1);
  assert.equal(pacer.intervalMs, MIN_INTERVAL_MS);
});

test('invalid measurements preserve the current interval', () => {
  const pacer = new FramePacer();
  assert.equal(pacer.observe(NaN), MIN_INTERVAL_MS);
  assert.equal(pacer.observe(-5), MIN_INTERVAL_MS);
});

test('frames are skipped by scheduling only, never by stretching game time', () => {
  assert.equal(shouldDrawFrame(1000, 1016), false);
  assert.equal(shouldDrawFrame(1016, 1016), true);
  assert.equal(shouldDrawFrame(1050, 1016), true);
});
