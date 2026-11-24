import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/lib/session.js';
import { Game } from '../src/lib/game.js';
import { getCourse } from '../src/lib/courses.js';

function makeSession(options = {}) {
  let now = 1000;
  const calls = [];
  const audio = {
    async prepare() {}, startMusic: offset => calls.push(['music', offset]), stopMusic() {},
    async suspend() {}, tick() {}, feedback() {}, now: () => now,
  };
  const session = new Session({ audio, clock: () => now, ...options });
  session.game = new Game(getCourse('beatucada'));
  return { session, calls, now: () => now, setNow: value => { now = value; } };
}

function startChart(session, now) {
  session._startChart(now);
}

test('chart origin waits for an audible downbeat when an audio offset is set', () => {
  const { session, now } = makeSession({ audioOffsetMs: 120 });
  startChart(session, now());
  assert.equal(session.game.origin, now() + 120);
  assert.equal(session.game.time(now()), 0, 'the chart does not run while the sound is still starting');
  assert.equal(session.game.time(now() + 120), 0, 'the downbeat lands when the offset elapses');
  assert.equal(session.game.time(now() + 240), 120);
});

test('a zero offset keeps the old behaviour exactly', () => {
  const { session, now } = makeSession();
  startChart(session, now());
  assert.equal(session.game.origin, now());
});

test('the tutorial never waits: it has no recording to align with', () => {
  const { session, now } = makeSession({ audioOffsetMs: 300 });
  session.tutorial = { index: 0, phase: 'demo', phaseAt: 0, hint: '', event: null };
  startChart(session, now());
  assert.equal(session.game.origin, now());
});

test('the offset is clamped to a sane calibration range', () => {
  assert.equal(makeSession({ audioOffsetMs: -50 }).session.audioOffsetMs, 0);
  assert.equal(makeSession({ audioOffsetMs: 5000 }).session.audioOffsetMs, 600);
  assert.equal(makeSession({ audioOffsetMs: 'oops' }).session.audioOffsetMs, 0);
});
