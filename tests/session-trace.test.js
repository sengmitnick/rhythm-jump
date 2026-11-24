import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/lib/session.js';
import { LANE_BY_ACTION } from '../src/lib/courses.js';
import { lateralStep, standing as still, upright, warmupSample } from './fixtures/motion.js';

const note = (id, atMs, action, kind = 'note') => ({ id, atMs, action, lane: LANE_BY_ACTION.get(action), kind });

function setup({ events, onTrace, rawTraceIntervalMs } = {}) {
  let now = 0, origin = 0;
  const trace = [], results = [];
  const session = new Session({
    clock: () => now,
    rawTraceIntervalMs,
    onTrace: event => { trace.push(event); onTrace?.(event); },
    onResult: (result, state) => results.push({ result, state }),
  });
  if (events) session.courses = [{ id: 'trace-test', version: 3, bpm: 120, durationMs: 3000, events }];
  const setTime = value => { now = value; };
  const sample = (at, extra = {}) => {
    setTime(at);
    session.sample({ ...warmupSample(session, at), ...extra });
  };
  const tick = at => { setTime(at); session.tick(); };
  // Run the pre-game sequence, then work in chart time so the tests do not
  // depend on how long the calibration happened to take.
  const play = () => {
    for (let at = 0; at <= 4000 && session.mode !== 'playing'; at += 20) { sample(at); tick(at); }
    assert.equal(session.mode, 'playing');
    origin = session.game.origin;
    return origin;
  };
  const at = elapsed => origin + elapsed;
  const hold = (action, from, to, step = 20) => {
    const start = Math.max(from, 0);
    for (let elapsed = start; elapsed < to; elapsed += step) {
      const when = at(elapsed);
      if (action === 'dodge-left') sample(when, { accel: lateralStep(-1, elapsed - start) });
      else if (action === 'dodge-right') sample(when, { accel: lateralStep(1, elapsed - start) });
      else if (action === 'jump') sample(when, { accel: { ...still, z: 0.5 } });
      else sample(when);
      tick(when);
    }
  };
  const idle = (from, to, step = 20) => hold(null, from, to, step);
  return { session, trace, results, setTime, sample, tick, play, hold, idle, at };
}

test('IMU trace preserves independent sensor timestamps and records calibration once', async () => {
  const fixture = setup(), { session, trace } = fixture;
  await session.start('imu');
  fixture.setTime(0);
  session.sample({ accel: { ...still, sensorTimestamp: 712300011 } });
  fixture.setTime(12);
  session.sample({ accel: { x: NaN, y: 0, z: 9.81, sensorTimestamp: 0 } });
  const [accel, invalid] = trace.filter(event => event.type === 'imu');
  assert.deepEqual([accel.sensor, accel.axes, accel.sensorTimestamp, accel.clockMs, accel.valid],
    ['accelerometer', [0, 0, 9.81], 712300011, 0, true]);
  assert.equal(invalid.valid, false);
  assert.equal(session.lastSample, 0, 'an invalid reading does not count as fresh');
  fixture.play();
  const calibration = trace.filter(event => event.type === 'calibration');
  assert.ok(calibration.length >= 1, 'the body baseline is recorded');
  assert.ok(calibration[0].samples > 20);
  assert.ok(Math.abs(calibration[0].gravity.z - 9.81) < 0.05);
  assert.deepEqual(calibration.map(event => event.kind), ['neutral']);
  assert.ok(trace.some(event => event.type === 'imu' && event.quaternion === upright));
});

test('throttled raw traces preserve full-rate scoring and completed jump metrics', async () => {
  const fixture = setup({ events: [note('jump', 1000, 'jump')], rawTraceIntervalMs: 80 });
  const { session, trace } = fixture;
  await session.start('imu');
  fixture.play();
  for (let elapsed = 20; elapsed <= 1300; elapsed += 20) {
    const z = elapsed >= 980 && elapsed < 1160 ? 0.5 : elapsed === 1160 ? 18 : 9.81;
    fixture.sample(fixture.at(elapsed), { accel: { ...still, z }, pose: { yaw: 0, pitch: 0 } });
    fixture.tick(fixture.at(elapsed));
  }
  const imu = trace.filter(event => event.type === 'imu');
  const poses = trace.filter(event => event.type === 'pose');
  assert.ok(imu.length > 10 && imu.slice(1).every((event, index) => event.clockMs - imu[index].clockMs >= 80));
  assert.ok(poses.length > 4 && poses.slice(1).every((event, index) => event.clockMs - poses[index].clockMs >= 200));
  const completed = trace.find(event => event.type === 'jump');
  assert.equal(completed.airMs, 180);
  assert.equal(completed.landing, 18);
  assert.equal(session.game.judgements[0].grade, 'perfect');
});

test('trace separates a wrong posture, a scored hold and a missed cue', async () => {
  const wall = note('wall', 500, 'dodge-left', 'wall');
  const jump = note('jump', 1100, 'jump');
  const unattended = note('unattended', 1900, 'jump');
  const fixture = setup({ events: [wall, jump, unattended] }), { session, trace } = fixture;
  await session.start('imu');
  fixture.play();

  // Moving the wrong way through the wall cue: no score, then a miss.
  fixture.hold('dodge-right', -300, 700);
  fixture.idle(700, 960);
  assert.equal(session.model().state.score, 0);
  assert.ok(trace.some(event => event.type === 'judgement' && event.judgement.id === wall.id && event.judgement.grade === 'miss'));

  fixture.hold('jump', 1040, 1140);
  const scored = trace.find(event => event.type === 'judgement' && event.judgement.id === jump.id);
  assert.equal(scored.judgement.grade, 'perfect');
  assert.equal(session.model().state.score, 1000);

  fixture.idle(1500, 2360);
  const missed = trace.filter(event => event.type === 'judgement' && event.judgement.id === unattended.id);
  assert.equal(missed.length, 1, 'a missed cue emits exactly one judgement');
  assert.equal(missed[0].judgement.grade, 'miss');
  assert.equal(missed[0].judgement.deltaMs, null);
});

test('posture is sampled into the log while playing', async () => {
  const events = [note('first', 500, 'dodge-left')];
  const fixture = setup({ events }), { session, trace } = fixture;
  await session.start('imu');
  fixture.play();
  fixture.hold('dodge-left', 0, 500);
  const posture = trace.filter(event => event.type === 'posture');
  assert.ok(posture.length >= 2, 'posture series recorded');
  assert.ok(posture.some(entry => entry.action === 'dodge-left'));
  assert.ok(posture.every(entry => Number.isFinite(entry.side) && Number.isFinite(entry.lift)));
});

test('a right stroke only scores once and an opposite stroke can score before it crosses centre', async () => {
  const events = [note('first-right', 700, 'dodge-right'), note('idle-right', 950, 'dodge-right'),
    note('later-right', 1450, 'dodge-right'), note('actual-left', 2300, 'dodge-left')];
  const fixture = setup({ events }), { session, trace } = fixture;
  await session.start('imu');
  fixture.play();
  for (let elapsed = 0; elapsed <= 2600; elapsed += 20) {
    const x = elapsed >= 400 && elapsed < 620 ? 7 : elapsed >= 620 && elapsed < 840 ? -7
      : lateralStep(-1, elapsed - 2000).x;
    fixture.sample(fixture.at(elapsed), { accel: { ...still, x } });
    fixture.tick(fixture.at(elapsed));
  }
  assert.deepEqual(session.game.judgements.map(({ id, grade }) => [id, grade === 'miss']), [
    ['first-right', false], ['idle-right', true], ['later-right', true], ['actual-left', false],
  ]);
  assert.ok(session.lastState.side > 0.08, 'the estimated position is still on the original right side');
  assert.deepEqual(trace.filter(row => row.type === 'lateral-hit').map(row => [row.cueId, Math.sign(row.move.distance)]), [
    ['first-right', 1], ['actual-left', -1],
  ]);
});

test('fresh same-direction movements can score on consecutive half-second beats', async () => {
  const events = Array.from({ length: 5 }, (_, i) => note(`right-${i}`, 400 + i * 500, 'dodge-right'));
  const fixture = setup({ events }), { session, trace } = fixture;
  await session.start('imu');
  fixture.play();
  fixture.idle(0, 140);
  for (const event of events) fixture.hold('dodge-right', event.atMs - 260, event.atMs + 240);
  assert.equal(session.game.judgements.length, events.length);
  assert.ok(session.game.judgements.every(row => row.grade !== 'miss'));
  assert.equal(trace.filter(row => row.type === 'lateral-hit').length, events.length);
});

test('completed and abandoned sessions each emit one compact end record', async () => {
  const events = [note('first', 500, 'dodge-left'), note('second', 1100, 'duck')];
  const fixture = setup({ events }), { session, trace, results } = fixture;
  await session.start('imu');
  const origin = fixture.play();
  fixture.idle(0, 3200);
  assert.equal(session.mode, 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].result.judgements.length, 2, 'normal score upload keeps its existing result');
  const completed = trace.find(event => event.type === 'end');
  assert.equal(completed.reason, 'completed');
  assert.deepEqual(completed.result, { score: 0, gameAccuracy: 0, maxCombo: 0, perfect: 0, good: 0, ok: 0, miss: 2 });

  session.home();
  assert.equal(trace.filter(event => event.type === 'end').length, 1);
  await session.start('imu');
  session.home();
  fixture.sample(origin + 3500);
  const ends = trace.filter(event => event.type === 'end');
  assert.equal(ends.length, 2);
  assert.equal(ends[1].reason, 'returned_home');
  assert.equal(ends[1].result, null);
  assert.equal(trace.at(-1).type, 'end', 'post-run samples do not leak into the archived run');
});

test('a throwing research observer cannot block calibration, posture input or scoring', async () => {
  const fixture = setup({
    events: [note('first', 500, 'dodge-left')],
    onTrace() { throw new Error('simulated storage observer failure'); },
  });
  await fixture.session.start('imu');
  fixture.play();
  fixture.hold('dodge-left', 270, 700);
  const result = fixture.session.model().state;
  assert.equal(result.score, 1000);
  assert.equal(result.last.grade, 'perfect');
});

test('time spent writing the raw sample does not shift its judgement window', async () => {
  const fixture = setup({ events: [note('first', 500, 'dodge-left')] });
  await fixture.session.start('imu');
  fixture.play();
  // A slow observer advances the clock during the first sample of the hold.
  let nudged = false;
  const collect = fixture.session.onTrace;
  fixture.session.onTrace = event => {
    collect(event);
    if (!nudged && event.type === 'imu') { nudged = true; fixture.setTime(fixture.session.clock() + 300); }
  };
  fixture.hold('dodge-left', 260, 560);
  assert.equal(nudged, true);
  const judgement = fixture.trace.find(event => event.type === 'judgement');
  assert.equal(judgement.judgement.grade, 'perfect');
  assert.ok(Math.abs(judgement.judgement.deltaMs) <= 80);
  assert.equal(fixture.session.model().state.score, 1000);
});
