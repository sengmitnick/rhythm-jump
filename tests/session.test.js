import test from 'node:test';
import assert from 'node:assert/strict';
import { warmupSample } from './fixtures/motion.js';
const lib = await import('../src/lib/session.js').catch(() => ({}));

function setup() {
  assert.equal(typeof lib.Session, 'function');
  let now = 0;
  const s = new lib.Session({ clock: () => now });
  return {
    s,
    set: value => { now = value; },
    time: value => { now = value; return s.tick(); },
    // Run until the pre-game sequence hands over to the chart.
    play(limit = 12000, step = 50) {
      for (let at = 0; at <= limit && s.mode !== 'playing'; at += step) { now = at; s.tick(); if (s.mode === 'playing') break; }
      assert.equal(s.mode, 'playing');
      return s.game.origin;
    },
  };
}

test('the pre-game sequence starts the selected course and the chart is scored', async () => {
  const { s, set, time, play } = setup();
  s.selected = s.courses.findIndex(course => course.id === 'stretch');
  await s.start('keyboard');
  assert.equal(s.model().mode, 'calibrating');
  const origin = play();
  assert.ok(origin > 0);
  time(origin + 4000);
  assert.equal(s.input('dodge-left').grade, 'perfect');
  s.pause();
  set(origin + 5000);
  assert.equal(s.model().state.elapsedMs, 4000);
  await s.confirm();
  time(origin + 5500);
  assert.equal(s.model().state.elapsedMs, 4500);
  s.home(); await s.start('keyboard');
  time(origin + 9000);
  assert.equal(s.model().state.score, 0);
});

test('missing IMU cannot silently start a scoring game', async () => {
  const { s, time } = setup();
  await s.start('imu');
  time(12000);
  assert.equal(s.model().mode, 'sensor-error');
  assert.equal(s.input('jump'), null);
});

test('home cancels calibration and sensor interruption pauses the game', async () => {
  const { s, set, time } = setup();
  await s.start('imu');
  s.home(); time(9000); assert.equal(s.model().mode, 'home');
  await s.start('imu');
  let now = 9000;
  for (let i = 0; i < 200 && s.mode !== 'playing'; i++) {
    now = 9000 + i * 20;
    set(now);
    s.sample(warmupSample(s, now));
    time(now);
  }
  const origin = s.game.origin;
  assert.equal(s.model().mode, 'playing');
  time(origin + 1500);
  time(origin + 4000);
  assert.equal(s.model().mode, 'paused');
});

test('an audio output failure does not stop the game or suppress input scoring', async () => {
  let now = 0;
  const audio = { prepare: async () => {}, tick() { throw new Error('speaker disconnected'); }, feedback() { throw new Error('speaker disconnected'); }, suspend: async () => {} };
  const s = new lib.Session({ audio, clock: () => now });
  await s.start('keyboard');
  for (; now <= 12000 && s.mode !== 'playing'; now += 50) s.tick();
  assert.equal(s.mode, 'playing');
  const first = s.game.course.events[0];
  now = s.game.origin + first.atMs; s.tick();
  assert.equal(s.input(first.action).grade, 'perfect');
  assert.equal(s.model().state.score, 1000);
});
