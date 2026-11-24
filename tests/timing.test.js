import test from 'node:test';
import assert from 'node:assert/strict';
import { RhythmAudio, DEFAULT_AUDIO_OFFSET_MS, normalizeAudioOffsetMs } from '../src/lib/audio.js';
import { Session } from '../src/lib/session.js';
import { Game } from '../src/lib/game.js';
import { getCourse } from '../src/lib/courses.js';

function makeSession({ audioDelayMs = 0, commandMs = 0, ...options } = {}) {
  let now = 1000;
  const calls = [];
  const audio = {
    async prepare() {},
    startMusic(positionMs) {
      calls.push(['music', positionMs]);
      now += commandMs;
      return { submittedAtMs: now, estimatedAudibleAtMs: now + audioDelayMs, positionMs };
    },
    stopMusic() {}, async suspend() {}, tick() {}, feedback() {},
  };
  const session = new Session({ audio, clock: () => now, ...options });
  session.game = new Game(getCourse('beatucada'));
  return { session, calls, now: () => now, setNow: value => { now = value; } };
}

test('native audio reports one monotonic audible-start anchor including command cost', async () => {
  let now = 1000;
  class Player {
    seek() { now += 2; }
    play() { now += 4; return Promise.resolve(); }
    stop() {}
    destroy() {}
  }
  const audio = new RhythmAudio(null, Player, { clock: () => now, audioOffsetMs: 80 });
  audio.setCourse({ music: '/assets/test.mp3', loopMusic: false });
  await audio.prepare();
  const timing = audio.startMusic(250);
  assert.deepEqual(timing, {
    requestedAtMs: 1000, submittedAtMs: 1006, commandMs: 6,
    audioOffsetMs: 80, estimatedAudibleAtMs: 1086, positionMs: 250,
  });
});

test('chart origin waits for the audible downbeat without stretching game time', () => {
  const { session, now } = makeSession({ audioDelayMs: 120, commandMs: 5 });
  session._startChart(now());
  assert.equal(session.game.origin, 1125);
  assert.equal(session.game.time(1005), 0, 'the chart stays at zero during output warm-up');
  assert.equal(session.game.time(1125), 0, 'the downbeat is chart time zero');
  assert.equal(session.game.time(1245), 120);
});

test('pause and resume apply audio latency once and seek to the frozen chart time', async () => {
  const fixture = makeSession({ audioDelayMs: 80 });
  fixture.session._startChart(fixture.now());
  fixture.setNow(2080);
  fixture.session.pause();
  assert.equal(fixture.session.game.elapsedMs, 1000);
  fixture.setNow(5000);
  await fixture.session.confirm();
  assert.deepEqual(fixture.calls, [['music', 0], ['music', 1000]]);
  assert.equal(fixture.session.game.time(5000), 1000);
  assert.equal(fixture.session.game.time(5080), 1000);
  assert.equal(fixture.session.game.time(5180), 1100);
});

test('audio warm-up cannot score early or rewind a resumed playhead', () => {
  const course = {
    id: 'warm-up', title: 'warm-up', durationMs: 3000, bpm: 120, sections: [],
    events: [{ id: 'beat', atMs: 1000, action: 'jump', kind: 'note', lane: 0 }],
  };
  const game = new Game(course);
  game.start(0);
  game.pause(1000);
  game.resume(5000, 80);
  let movementAt = 5040;
  const body = {
    matches: action => action === 'jump', sinceFor: () => movementAt, consume() {},
  };
  assert.equal(game.time(4990), 1000, 'queued timestamps never move the chart backwards');
  assert.equal(game.sync(body, 5040), null, 'silence before estimated output onset cannot score');
  assert.equal(game.sync(body, 5080), null, 'a movement made during warm-up stays ineligible');
  movementAt = 5080;
  assert.equal(game.sync(body, 5080).grade, 'perfect');
});

test('sensor judgement remains immediate on the callback clock', () => {
  let now = 1234;
  const session = new Session({ clock: () => now, displayOffsetMs: 200 });
  const samples = [], syncs = [];
  session.body = {
    lastJump: null, lateralMove: null,
    sample(_reading, at) { samples.push(at); return { action: 'idle' }; },
  };
  session.game = {
    sync(_body, at) { syncs.push(at); return null; },
    time: () => 0,
  };
  session.mode = 'playing';
  session.sample({ pose: { valid: true }, clockMs: 100 });
  assert.deepEqual(samples, [1234]);
  assert.deepEqual(syncs, [1234]);
  assert.equal(session.lastSample, null, 'pose-only samples do not fake IMU liveness');
});

test('tutorial has no recording and therefore never waits for an audio anchor', () => {
  const { session, calls, now } = makeSession({ audioDelayMs: 300 });
  session.tutorial = { index: 0, phase: 'demo', phaseAt: 0, hint: '', event: null };
  session._startChart(now());
  assert.equal(session.game.origin, now());
  assert.deepEqual(calls, []);
});

test('timing calibration defaults and clamps are explicit', () => {
  assert.equal(DEFAULT_AUDIO_OFFSET_MS, 80);
  assert.equal(normalizeAudioOffsetMs(undefined), 80);
  assert.equal(normalizeAudioOffsetMs(-50), 0);
  assert.equal(normalizeAudioOffsetMs(5000), 500);
  assert.equal(normalizeAudioOffsetMs('oops'), 80);
  assert.equal(makeSession({ displayOffsetMs: 999 }).session.displayOffsetMs, 250);
  assert.equal(makeSession({ displayOffsetMs: -999 }).session.displayOffsetMs, -250);
});
