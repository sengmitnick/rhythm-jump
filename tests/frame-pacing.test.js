import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_INTERVAL_MS, MAX_INTERVAL_MS, nextFrameInterval, shouldDrawFrame } from '../src/lib/frame-pacing.js';

test('frame pacing starts at the 60 fps budget and never leaves the safe range', () => {
  assert.equal(MIN_INTERVAL_MS, 1000 / 60);
  assert.equal(MAX_INTERVAL_MS, 1000 / 24);
  let interval = MIN_INTERVAL_MS;
  for (let i = 0; i < 40; i++) interval = nextFrameInterval(interval, 1);
  assert.ok(interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS);
});

test('an expensive frame widens the interval and an idle one narrows it back', () => {
  const slow = nextFrameInterval(MIN_INTERVAL_MS, MIN_INTERVAL_MS * 0.9);
  assert.ok(slow > MIN_INTERVAL_MS, 'cost above half the budget must back off');
  const fast = nextFrameInterval(slow, MIN_INTERVAL_MS * 0.05);
  assert.ok(fast < slow, 'an idle frame must recover headroom');
});

test('back-off is bounded so recording cannot collapse the loop', () => {
  let interval = MIN_INTERVAL_MS;
  for (let i = 0; i < 200; i++) interval = nextFrameInterval(interval, 400);
  assert.equal(interval, MAX_INTERVAL_MS);
});

test('invalid measurements keep the current interval instead of jittering', () => {
  assert.equal(nextFrameInterval(MIN_INTERVAL_MS, NaN), MIN_INTERVAL_MS);
  assert.equal(nextFrameInterval(MIN_INTERVAL_MS, -5), MIN_INTERVAL_MS);
  assert.equal(nextFrameInterval(0, 1), MIN_INTERVAL_MS);
});

test('frames are skipped by not drawing, never by stretching the clock', () => {
  assert.equal(shouldDrawFrame(1000, 1016), false);
  assert.equal(shouldDrawFrame(1016, 1016), true);
  assert.equal(shouldDrawFrame(1050, 1016), true);
});
