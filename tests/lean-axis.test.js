import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadPose, invertQuaternion, rotateVectorByQuaternion, rotationAxis, twistAbout } from '../src/lib/head-pose.js';
import { Session } from '../src/lib/session.js';
import { lateralStep, standing as still, upright as identity, tutorialSample, warmupSample } from './fixtures/motion.js';

const lean = angle => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];

test('a lean shows up as a twist about the measured axis, not the device X axis', () => {
  const head = new HeadPose();
  head.setReference(identity, 0);
  head.setRollAxis([0, 0, 1], -1);
  head.sample(lean(0.35), 100);
  head.sample(lean(-0.35), 200);
  const left = new HeadPose();
  left.setReference(identity, 0);
  left.setRollAxis([0, 0, 1], -1);
  left.sample(lean(0.35), 100);
  assert.ok(left.pose(100).roll < -0.2, 'leaning left reads negative');
  const right = new HeadPose();
  right.setReference(identity, 0);
  right.setRollAxis([0, 0, 1], -1);
  right.sample(lean(-0.35), 100);
  assert.ok(right.pose(100).roll > 0.2, 'leaning right reads positive');
});

test('the axis is derived from two opposite leans', () => {
  const left = rotationAxis(identity, lean(0.4));
  const right = rotationAxis(identity, lean(-0.4));
  const v = [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
  const length = Math.hypot(...v);
  assert.ok(length > 0.08);
  assert.ok(Math.abs(v[2] / length) > 0.99, 'the difference points along the lean axis');
  assert.ok(Math.abs(twistAbout(lean(0.4), [0, 0, 1])) - 0.4 < 1e-6);
});

test('two successes per side and one jump complete the tutorial', async () => {
  let now = 0, completed = 0;
  const trace = [], repeats = [];
  const session = new Session({
    clock: () => now, onTrace: row => trace.push(row), onTutorialComplete() { completed++; },
    onTutorialRepeat(action) {
      repeats.push([action, session.model().tutorial.attempt]);
    },
  });
  await session.start('imu', { tutorial: true });
  for (; now <= 19500 && session.mode !== 'home'; now += 20) {
    session.sample(tutorialSample(session, now));
    session.tick();
  }
  assert.equal(session.mode, 'home');
  assert.ok(now >= 7500 && now < 19500);
  assert.equal(completed, 1);
  assert.equal(session.tutorialComplete, true);
  assert.deepEqual(trace.filter(row => row.type === 'tutorial-action').map(row => [row.action, row.attempt, row.success]), [
    ['dodge-left', 1, true], ['dodge-left', 2, true],
    ['dodge-right', 1, true], ['dodge-right', 2, true], ['jump', 1, true],
  ]);
  assert.deepEqual(repeats, [['dodge-left', 2], ['dodge-right', 2]]);
  const jumpResult = trace.filter(row => row.type === 'judgement').at(-1);
  assert.equal(jumpResult.expected.action, 'jump');
  assert.equal(trace.at(-1).reason, 'tutorial_completed');
  assert.deepEqual(session.baseQuaternion, identity);

  await session.start('imu');
  assert.equal(session.mode, 'calibrating');
  assert.equal(session.model().stand.step, 'checking');
  for (const end = now + 220; now <= end && session.mode === 'calibrating'; now += 20) {
    session.sample(warmupSample());
    session.tick();
  }
  assert.equal(session.mode, 'playing');
  assert.equal(trace.filter(row => row.type === 'calibration').at(-1).kind, 'reused');

  session.home();
  const facing = [0, Math.sin(0.2), 0, Math.cos(0.2)];
  session.sample({ accel: still, quaternion: facing });
  await session.start('imu');
  assert.equal(session.model().stand.step, 'checking');
  let recaptured = false;
  for (const end = now + 900; now <= end && session.mode === 'calibrating'; now += 20) {
    session.sample({ accel: still, quaternion: facing });
    session.tick();
    recaptured ||= session.calibrationStep === 'capture';
  }
  assert.equal(recaptured, true, 'a materially changed heading requests a new neutral capture');
  assert.equal(session.mode, 'playing');
  assert.equal(session.tutorial, null, 'a new heading never restarts completed instruction');
  assert.ok(session.baseQuaternion.every((value, index) => Math.abs(value - facing[index]) < 1e-9));
  assert.equal(completed, 1);
});

test('song calibration is independent of the tutorial and reuse waits for new paired data', async () => {
  let now = 0, musicStarts = 0;
  const audio = { async prepare() {}, startMusic() { musicStarts++; }, stopMusic() {}, async suspend() {} };
  const trace = [];
  const session = new Session({ audio, clock: () => now, requireUpright: true, onTrace: row => trace.push(row) });
  // The latest field run captured a comfortable but downward 22° gaze.
  const accel = { x: 0.162, y: 9.054, z: -3.688 };
  const fresh = () => session.sample({ accel: { ...accel, sensorTimestamp: now }, quaternion: identity });
  await session.start('imu');
  assert.equal(session.mode, 'calibrating');
  assert.equal(session.tutorialComplete, false);
  assert.equal(musicStarts, 0);
  for (; now < 500; now += 20) { fresh(); session.tick(); }
  assert.equal(session.mode, 'calibrating');
  assert.equal(musicStarts, 0);
  fresh(); session.tick();
  assert.equal(session.mode, 'playing');
  assert.equal(session.calibrationReady, true);
  assert.equal(session.tutorialComplete, false);
  assert.equal(session.tutorial, null);
  assert.equal(musicStarts, 1);
  session.home();

  // A deliberately inactive stream can retain the earlier reference. Every
  // start still needs new, stable observations, regardless of estimate drift.
  now += 5000;
  session.body.side = -0.65;
  session.body.lift = -0.8;
  session.lastState = session.body.snapshot(now);
  await session.start('imu');
  assert.equal(session.model().stand.step, 'checking');
  const duplicateTimestamp = now;
  for (const end = now + 320; now <= end; now += 20) {
    session.sample({ accel: { ...accel, sensorTimestamp: duplicateTimestamp }, quaternion: identity });
    session.tick();
  }
  assert.equal(session.mode, 'calibrating', 'repeated callbacks for one sensor sample cannot complete the check');
  assert.equal(musicStarts, 1);
  for (const end = now + 160; now <= end; now += 20) { fresh(); session.tick(); }
  assert.equal(session.mode, 'calibrating');
  fresh(); session.tick();
  assert.equal(session.mode, 'playing');
  assert.equal(musicStarts, 2);
  assert.equal(trace.filter(row => row.type === 'calibration').at(-1).kind, 'reused');
});

test('an interrupted stream discards reuse and an unpaired stream cannot calibrate', async () => {
  let now = 0;
  const session = new Session({ clock: () => now });
  await session.start('imu');
  for (; now <= 500; now += 20) { session.sample(warmupSample()); session.tick(); }
  assert.equal(session.mode, 'playing');
  assert.equal(session.calibrationReady, true);
  session.home();
  session.interruptImu();
  await session.start('imu');
  assert.equal(session.model().stand.step, 'capture');
  assert.equal(session.calibrationReady, false);
  for (const end = now + 800; now <= end; now += 20) {
    session.sample({ accel: still, quaternion: null });
    session.tick();
  }
  assert.equal(session.mode, 'calibrating');
  assert.equal(session.model().stand.still, 0);
  for (const end = now + 500; now <= end; now += 20) { session.sample(warmupSample()); session.tick(); }
  assert.equal(session.mode, 'playing');
  assert.equal(session.calibrationReady, true);
});

test('a final tick without fresh paired data invalidates the saved reference', async () => {
  let now = 0;
  const session = new Session({ clock: () => now });
  session.courses = [{ id: 'signal-gap', version: 1, bpm: 120, durationMs: 300, events: [] }];
  await session.start('imu');
  for (; now <= 500; now += 20) { session.sample(warmupSample()); session.tick(); }
  assert.equal(session.calibrationReady, true);
  now += 400;
  session.tick();
  assert.equal(session.mode, 'result', 'the completed round can still display its score');
  assert.equal(session.calibrationReady, false);
  await session.start('imu');
  assert.equal(session.model().stand.step, 'capture');
});

test('turning the head in place leaves the same exercise waiting without a miss', async () => {
  let now = 0;
  const trace = [];
  const session = new Session({ clock: () => now, onTrace: row => trace.push(row) });
  await session.start('imu', { tutorial: true });
  for (; now <= 5100; now += 20) {
    session.sample({ accel: still, quaternion: session.mode === 'tutorial' ? lean(0.35 * Math.sin(now / 120)) : identity });
    session.tick();
  }
  assert.equal(session.mode, 'tutorial');
  assert.equal(session.model().tutorial.action, 'dodge-left');
  assert.equal(session.model().tutorial.phase, 'ready');
  assert.equal(session.tutorialComplete, false);
  assert.equal(trace.some(row => row.type === 'tutorial-action'), false);
  assert.equal(session.game.judgements.length, 0);
});

test('practice ignores demo movement and keeps the initial orientation and gravity reference', async () => {
  let now = 0;
  const session = new Session({ clock: () => now });
  await session.start('imu', { tutorial: true });
  for (; session.mode === 'calibrating'; now += 20) { session.sample(warmupSample()); session.tick(); }
  const { baseQuaternion } = session;
  const { worldGravity } = session.body;
  for (; session.model().tutorial.phase === 'demo'; now += 20) {
    const elapsed = session.game.time(now);
    session.sample({ ...warmupSample(), accel: lateralStep(-1, elapsed - 400) });
    session.tick();
  }
  assert.equal(session.game.judgements.length, 0);
  assert.equal(session.body.lateralMove, null);
  assert.equal(session.baseQuaternion, baseQuaternion);
  assert.equal(session.body.worldGravity, worldGravity);
  for (const end = now + 500; now <= end && session.model().tutorial.phase === 'ready'; now += 20) {
    session.sample(tutorialSample(session, now));
    session.tick();
  }
  assert.equal(session.model().tutorial.phase, 'success');
  assert.equal(session.game.judgements.length, 1);
});

test('a short seated hop retries the jump lesson and a sustained jump clears it', async () => {
  let now = 0, triedShortHop = false;
  let jumpId = null;
  const trace = [];
  const session = new Session({ clock: () => now, onTrace: row => trace.push(row) });
  await session.start('imu', { tutorial: true });
  for (; now <= 23000 && session.mode !== 'home'; now += 20) {
    const lesson = session.tutorial;
    if (lesson?.event.action === 'jump' && lesson.phase === 'ready') {
      jumpId ??= lesson.event.id;
      const delta = session.game.time(now) - lesson.phaseAt;
      const weak = delta >= 120 && delta < 200;
      if (weak) triedShortHop = true;
      let load = 9.81;
      if (delta >= 60 && delta < 120 || delta >= 900 && delta < 960) load = 20;
      if (weak || delta >= 960 && delta < 1120) load = 0.5;
      if (delta >= 1120 && delta < 1140) load = 22;
      session.sample({ ...warmupSample(), accel: { ...still, z: load } });
      assert.equal(lesson.event.id, jumpId, 'a weak gesture does not start a new timed cue');
    } else session.sample(tutorialSample(session, now));
    session.tick();
  }
  assert.equal(triedShortHop, true);
  assert.deepEqual(trace.filter(row => row.action === 'jump' && row.type === 'tutorial-action').map(row => row.success), [false, true]);
  assert.equal(session.tutorialComplete, true);
});

test('tutorial waits for the player and plays no backing beat or false failure', async () => {
  let now = 0;
  const audioCalls = [];
  const audio = { async prepare() {}, startMusic() { audioCalls.push('recording'); }, tick() { audioCalls.push('beat'); } };
  const session = new Session({ clock: () => now, audio });
  await session.start('imu', { tutorial: true });
  for (; now <= 22000; now += 20) {
    session.sample(warmupSample());
    session.tick();
  }
  assert.equal(session.mode, 'tutorial');
  assert.equal(session.tutorial.event.action, 'dodge-left');
  assert.equal(session.model().tutorial.phase, 'ready');
  assert.equal(session.game.judgements.length, 0);
  assert.deepEqual(audioCalls, []);
});

test('glasses calibration rejects the inverted field reading and recovers after they are worn upright', async () => {
  let now = 0;
  const trace = [];
  const session = new Session({ clock: () => now, requireUpright: true, onTrace: row => trace.push(row) });
  await session.start('imu', { tutorial: true });
  const inverted = { x: 0.006, y: -9.135, z: -3.588 };
  const worn = { x: -0.14, y: 9.738, z: 1.13 };

  for (; now <= 2000; now += 20) {
    session.sample({ accel: inverted, quaternion: [0, 0, 1, 0] });
    session.tick();
  }
  assert.equal(session.mode, 'calibrating');
  assert.match(session.model().stand.hint, /戴好眼镜/);
  assert.equal(session.model().stand.still, 0);

  const pickedUpAt = now;
  for (; now < pickedUpAt + 500; now += 20) {
    session.sample({ accel: worn, quaternion: identity });
    session.tick();
  }
  assert.equal(session.mode, 'calibrating', 'inverted samples do not count toward the standing window');
  session.sample({ accel: worn, quaternion: identity });
  session.tick();
  assert.equal(session.mode, 'tutorial');
  const calibration = trace.filter(row => row.type === 'calibration');
  assert.equal(calibration.length, 1);
  assert.deepEqual(calibration[0].gravity, worn);
  assert.deepEqual(calibration[0].quaternion, identity);
  assert.ok(session.body.worldRight[0] > 0.99);
});

test('neutral calibration preserves world gravity during small head-angle drift', async () => {
  let now = 0;
  const trace = [];
  const session = new Session({ clock: () => now, onTrace: row => trace.push(row) });
  await session.start('imu');

  for (; now <= 800; now += 20) {
    const angle = Math.min(1, now / 500) * 0.065;
    const quaternion = [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
    const [x, y, z] = rotateVectorByQuaternion([0, 0, 9.81], invertQuaternion(quaternion));
    session.sample({ accel: { x, y, z }, quaternion });
    session.tick();
  }

  assert.equal(session.mode, 'playing');
  const calibration = trace.find(row => row.type === 'calibration');
  assert.equal(calibration.clockMs, 500);
  assert.ok(Math.abs(calibration.worldGravity[0]) < 1e-6);
  assert.ok(Math.abs(calibration.worldGravity[2] - 9.81) < 1e-6);
  assert.ok(Math.abs(session.lastState.lateralAccel) < 1e-6);
});
