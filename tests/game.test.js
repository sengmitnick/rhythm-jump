import test from 'node:test';
import assert from 'node:assert/strict';
import { invertQuaternion, multiplyQuaternions, rotateVectorByQuaternion } from '../src/lib/head-pose.js';

const core = await import('../src/lib/game.js').catch(() => ({}));
const charts = await import('../src/lib/courses.js').catch(() => ({}));
const body = await import('../src/lib/body-state.js').catch(() => ({}));

const still = { x: 0, y: 0, z: 9.81 };

test('the original courses retain their timing and posture-friendly spacing', () => {
  assert.equal(typeof charts.getCourses, 'function');
  const courses = ['practice', 'party-full', 'stretch', 'step', 'jump'].map(charts.getCourse);
  assert.deepEqual(courses.map(c => [c.bpm, c.durationMs]), [[120, 20000], [120, 96000], [108, 60000], [120, 75000], [132, 90000]]);
  for (const c of courses.slice(1)) {
    assert.deepEqual([...new Set(c.events.map(e => e.action))].sort(),
      charts.ACTIVE_ACTIONS.slice().sort(), `${c.id} uses the enabled moves`);
    assert.ok(c.events.every(e => e.atMs > 1500 && e.atMs < c.durationMs - 500));
    assert.equal(new Set(c.events.map(e => e.id)).size, c.events.length);
    for (let i = 1; i < c.events.length; i++) {
      const gap = c.events[i].atMs - c.events[i - 1].atMs;
      if (c.events[i].action === c.events[i - 1].action) assert.ok(gap >= 400, `${c.id} sustain ${gap}ms`);
      else assert.ok(gap >= 620, `${c.id} transition ${gap}ms`);
    }
    // A sustained run is what makes a long tone feel held rather than tapped.
    let run = 1, longest = 1;
    for (let i = 1; i < c.events.length; i++) {
      run = c.events[i].action === c.events[i - 1].action ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    assert.ok(longest >= 3, `${c.id} has a sustained run`);
  }
});

function fixture(events) {
  return new core.Game({
    id: 'fixture', durationMs: 5000, bpm: 120,
    events: events || [
      { id: 'a', atMs: 1000, action: 'dodge-left', kind: 'note', lane: 2 },
      { id: 'b', atMs: 1500, action: 'dodge-left', kind: 'note', lane: 2 },
      { id: 'c', atMs: 2500, action: 'jump', kind: 'note', lane: 0 },
      { id: 'd', atMs: 3500, action: 'duck', kind: 'wall', lane: 1 },
    ],
  });
}
const pose = (action, since) => ({ action, since });

test('an adapter supplying a held posture can score a sustained run', () => {
  const g = fixture(); g.start(0);
  // One lean held from before the first cue covers both cues on that side.
  const held = pose('dodge-left', -500);
  assert.equal(g.sync(held, 1000).grade, 'perfect');
  assert.equal(g.sync(held, 1500).grade, 'perfect');
  assert.equal(g.snapshot(1500).combo, 2);
});

test('a transition is timed, while arriving early is never rewarded or punished', () => {
  for (const [arrivedAt, grade] of [[960, 'perfect'], [1150, 'good'], [300, 'perfect']]) {
    const g = fixture(); g.start(0);
    assert.equal(g.sync(pose('dodge-left', arrivedAt), 1000).grade, grade, `arrived ${arrivedAt}`);
  }
});

test('a wrong posture misses once the window closes, and never scores', () => {
  const g = fixture(); g.start(0);
  assert.equal(g.sync(pose('dodge-right', -500), 1100), null, 'still inside the window');
  const missed = g.sync(pose('dodge-right', -500), 1001 + core.OK_MS);
  assert.equal(missed.grade, 'miss');
  assert.equal(missed.id, 'a');
  assert.equal(g.snapshot(1001 + core.OK_MS).score, 0);
});

test('a wall is judged exactly like a tile, by its posture only', () => {
  const g = fixture([
    { id: 'a', atMs: 1000, action: 'duck', kind: 'wall', lane: 1 },
    { id: 'b', atMs: 2000, action: 'jump', kind: 'note', lane: 0 },
  ]);
  g.start(0);
  assert.equal(g.sync(pose('duck', 400), 1000).grade, 'perfect');
  assert.equal(g.sync(pose('jump', 1980), 2000).grade, 'perfect');
});

test('cues resolve in chart order even when several are due at once', () => {
  const g = fixture([
    { id: 'a', atMs: 1000, action: 'dodge-left', kind: 'note', lane: 2 },
    { id: 'b', atMs: 1400, action: 'dodge-left', kind: 'note', lane: 2 },
    { id: 'c', atMs: 1800, action: 'dodge-left', kind: 'note', lane: 2 },
  ]);
  g.start(0);
  const held = pose('dodge-left', -100);
  g.sync(held, 1900);
  assert.deepEqual(g.judgements.map(j => j.id), ['a'], 'one cue per call');
  g.sync(held, 1900);
  g.sync(held, 1900);
  assert.deepEqual(g.judgements.map(j => j.id), ['a', 'b', 'c']);
});

test('non-finite time never scores and pause freezes the clock', () => {
  const g = fixture(); g.start(0);
  assert.equal(g.sync(pose('dodge-left', -10), NaN), null);
  g.pause(600);
  assert.equal(g.snapshot(10000).elapsedMs, 600);
  g.resume(10000);
  assert.equal(g.sync(pose('dodge-left', -10), 10500).grade, 'perfect');
});

test('tick expires an unattended cue once, and finish is replayable', () => {
  const g = fixture(); g.start(0);
  g.tick(1001 + core.EXPIRE_MS);
  assert.equal(g.snapshot(1001 + core.EXPIRE_MS).miss, 1);
  g.tick(1010 + core.EXPIRE_MS);
  assert.equal(g.snapshot(1010 + core.EXPIRE_MS).miss, 1);
  g.tick(5100); g.tick(5200);
  const s = g.snapshot(5200);
  assert.equal(s.status, 'finished');
  assert.equal(g.result().judgements.length, 4);
});

test('all three courses finish on a perfect hold of every run', () => {
  for (const c of charts.getCourses()) {
    const g = new core.Game(c); g.start(0);
    let held = null;
    for (const e of c.events) {
      if (!held || held.action !== e.action) held = { action: e.action, since: e.atMs - 1000 };
      const hit = g.sync(held, e.atMs);
      assert.equal(hit?.grade, 'perfect', `${c.id} ${e.id}`);
    }
    g.tick(c.durationMs);
    const s = g.snapshot(c.durationMs);
    assert.equal(s.accuracy, 100);
    assert.equal(s.miss, 0);
    assert.equal(s.score, c.events.length * 1000);
  }
});

// ---------------------------------------------------------------- posture
function idle(state, from, to, step = 20) {
  for (let t = from; t < to; t += step) state.sample({ accel: still }, t);
  return state;
}
function dropFor(state, from, accelZ, ms, step = 20) {
  let t = from;
  for (; t < from + ms; t += step) state.sample({ accel: { x: 0, y: 0, z: accelZ } }, t);
  return t;
}

test('a squat is tracked and then held without drifting away', () => {
  assert.equal(typeof body.BodyState, 'function');
  const state = new body.BodyState();
  idle(state, 0, 2000);
  // 0.3 m down in 0.4 s: accelerate, then brake.
  let t = dropFor(state, 2000, 2.4, 200);
  t = dropFor(state, t, 16.2, 200);
  idle(state, t, t + 400);
  const held = state.snapshot(t + 400);
  assert.equal(held.action, 'duck', `lift ${held.lift.toFixed(3)}`);
  // Still crouched one second later: the zero-velocity update must hold it.
  idle(state, t + 400, t + 1400);
  assert.equal(state.snapshot(t + 1400).action, 'duck');
});

const reference = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

function axisAngle(axis, angle) {
  return [...axis.map(value => value * Math.sin(angle / 2)), Math.cos(angle / 2)];
}

function lateralFixture(options = {}) {
  const state = new body.BodyState(options);
  let now = 0;
  function read(world, quaternion = reference, roll = 0) {
    const [x, y, z] = rotateVectorByQuaternion(world, invertQuaternion(quaternion));
    return state.sample({ accel: { x, y, z }, quaternion, pose: { roll } }, now += 20);
  }
  function rest(cycles = 15) {
    for (let i = 0; i < cycles; i++) read([0, 0, 9.81]);
  }
  function step(direction, acceleration = 5) {
    for (let i = 0; i < 10; i++) read([direction * acceleration, 0, 9.81]);
    for (let i = 0; i < 10; i++) read([-direction * acceleration, 0, 9.81]);
    rest(8);
  }
  rest();
  state.calibrate(now, reference);
  rest();
  return { state, read, rest, step, clock: () => now };
}

test('a fresh left step registers even while the estimated position is still to the right', () => {
  const { state, rest, step } = lateralFixture();
  step(1, 8);
  assert.equal(state.snapshot().action, 'dodge-right');
  const position = state.snapshot().side;
  rest(120);
  assert.equal(state.snapshot().side, position, 'position stays still when the player holds it');
  assert.equal(state.snapshot().action, 'stand');
  step(-1);
  assert.ok(state.snapshot().side > 0.08, 'no need to cross the original position');
  assert.equal(state.snapshot().action, 'dodge-left');
});

test('a braked motion becomes ready while the accumulated estimate remains off-center', () => {
  const { state, read, rest, step, clock } = lateralFixture();
  assert.equal(state.snapshot().motionPhase, 'ready');
  for (let i = 0; i < 10; i++) read([5, 0, 9.81]);
  assert.equal(state.snapshot().motionDirection, 'dodge-right');
  assert.equal(state.snapshot().motionPhase, 'moving');

  assert.equal(state.consume('dodge-right', clock()), true);
  assert.equal(state.snapshot().lateralMove, null);
  assert.equal(state.snapshot().motionDirection, 'dodge-right', 'scoring does not remove motion feedback');
  for (let i = 0; i < 7; i++) {
    const reading = read([-6, 0, 9.81]);
    assert.equal(reading.motionPhase, 'settling');
    assert.equal(state.matches('dodge-left'), false, 'braking is not a new left movement');
  }
  assert.ok(state.sideVelocity > 0.14 && state.sideVelocity <= 0.18, 'the velocity has a small residual');
  rest(4);
  assert.equal(state.snapshot().motionPhase, 'ready');
  assert.equal(state.snapshot().sideVelocity, 0);
  assert.ok(state.snapshot().side > 0.10);
  rest(18);
  assert.equal(state.snapshot().motionDirection, null);
  assert.equal(state.snapshot().motionPhase, 'ready');

  step(-1);
  assert.equal(state.matches('dodge-left'), true, 'the intention to go left is judged after rearming');
});

test('continuous reversal detects a second movement once, without treating initial braking as a step', () => {
  const { state, read } = lateralFixture();
  const moves = [];
  for (let i = 0; i < 40; i++) {
    const sample = read([i < 10 || i >= 30 ? 5 : -5, 0, 9.81]);
    if (sample.lateralMove && sample.lateralMove !== moves.at(-1)?.move) {
      moves.push({ move: sample.lateralMove, sampleIndex: i });
    }
  }
  assert.deepEqual(moves.map(({ move }) => move.action), ['dodge-right', 'dodge-left']);
  assert.ok(moves[1].sampleIndex >= 20, 'braking the right step does not count as moving left');
  assert.equal(state.snapshot().action, 'dodge-left');
});

test('a new right step can register after the running position estimate reaches its cap', () => {
  const { state, step, clock } = lateralFixture();
  for (let i = 0; i < 4; i++) {
    step(1, 8);
    assert.ok(state.matches('dodge-right'));
    assert.equal(state.consume('dodge-right', clock()), true);
    assert.equal(state.matches('dodge-right'), false);
  }
  assert.equal(state.snapshot().side, state.options.lateralMaxPosition);
});

test('braking then driving the same way again registers successive steps without a quiet gap', () => {
  for (const [direction, action] of [[1, 'dodge-right'], [-1, 'dodge-left']]) {
    const { state, read, rest, clock } = lateralFixture();
    const steps = [];
    for (let step = 0; step < 3; step++) {
      for (let sample = 0; sample < 29; sample++) {
        const reading = read([(sample < 17 ? 2 : -3) * direction, 0, 9.81]);
        if (reading.lateralMove) {
          steps.push(reading.lateralMove.action);
          assert.equal(state.consume(reading.lateralMove.action, clock()), true);
        }
      }
    }
    rest(30);
    assert.deepEqual(steps, [action, action, action], 'each new acceleration lobe counts once');
    assert.equal(state.snapshot().lateralMove, null, 'a stationary stance cannot create another event');
  }
});

test('an unbroken acceleration signal cannot repeatedly rearm a lateral movement', () => {
  const { state, read, clock } = lateralFixture();
  for (const direction of [-1, 1]) {
    state.calibrate(clock(), reference);
    let moves = 0;
    for (let i = 0; i < 160; i++) {
      const { lateralMove } = read([2 * direction, 0, 9.81]);
      if (lateralMove) {
        moves++;
        state.consume(lateralMove.action, clock());
      }
    }
    assert.equal(moves, 1);
  }
});

test('a sustained counterstroke can rearm after the original direction times out', () => {
  const { state, read, clock } = lateralFixture();
  const moves = [];
  function drive(acceleration, samples) {
    for (let i = 0; i < samples; i++) {
      const { lateralMove } = read([acceleration, 0, 9.81]);
      if (!lateralMove) continue;
      moves.push(lateralMove.action);
      state.consume(lateralMove.action, clock());
    }
  }
  drive(2, 66);
  assert.deepEqual(moves, ['dodge-right']);
  drive(-6, 1);
  drive(2, 12);
  assert.deepEqual(moves, ['dodge-right'], 'a short counter-impulse does not rearm the old direction');
  drive(-5, 18);
  assert.deepEqual(moves, ['dodge-right', 'dodge-left']);
});

test('different step and return speeds do not accumulate displacement at centre', () => {
  const { state, read, rest, clock } = lateralFixture();
  function move(distance, cycles) {
    const seconds = cycles * 0.02;
    const started = clock();
    const expected = distance < 0 ? 'dodge-left' : 'dodge-right';
    let detected = false;
    for (let i = 0; i < cycles; i++) {
      const progress = (i + 0.5) / cycles;
      const acceleration = distance * (60 * progress - 180 * progress ** 2 + 120 * progress ** 3) / seconds ** 2;
      const { lateralMove } = read([acceleration + Math.sin(clock() / 22) * 0.12, 0, 9.81]);
      detected ||= lateralMove?.action === expected && lateralMove.at > started;
    }
    rest(8);
    return detected;
  }
  for (let repetition = 0; repetition < 8; repetition++) {
    for (const [direction, out, back] of [[-1, 30, 22], [1, 31, 24]]) {
      assert.equal(move(direction * 0.18, out), true);
      move(-direction * 0.18, back);
      assert.equal(state.snapshot().side, 0);
    }
  }
});

function turnHead(read, axis, angle, translate = 0) {
  const duration = 0.40;
  const offset = [0, 0.17, -0.09];
  function orientation(t) {
    const progress = Math.max(0, Math.min(1, t / duration));
    const eased = progress ** 3 * (10 + progress * (-15 + progress * 6));
    return multiplyQuaternions(axisAngle(axis, angle * eased), reference);
  }
  function position(t) { return rotateVectorByQuaternion(offset, orientation(t)); }
  const epsilon = 0.001;
  for (let index = 1; index <= 35; index++) {
    const t = index * 0.02;
    const before = position(t - epsilon), center = position(t), after = position(t + epsilon);
    const world = center.map((value, i) => (before[i] - 2 * value + after[i]) / epsilon ** 2);
    world[0] += index <= 10 ? translate : index <= 20 ? -translate : 0;
    world[2] += 9.81;
    read(world, orientation(t), angle);
  }
}

test('roll or yaw around the neck stays neutral even with the glasses moving in an arc', () => {
  for (const [axis, angle] of [[[0, 1, 0], 0.75], [[0, 1, 0], -0.75], [[0, 0, 1], 1.4]]) {
    const { state, read } = lateralFixture();
    turnHead((...args) => {
      read(...args);
      assert.equal(state.matches('dodge-left'), false);
      assert.equal(state.matches('dodge-right'), false);
    }, axis, angle);
  }
});

test('a body shift still registers when the wearer also tilts their head', () => {
  const { state, read } = lateralFixture();
  let detected = false;
  turnHead((...args) => {
    read(...args);
    detected ||= state.matches('dodge-left');
  }, [0, 1, 0], -0.40, -5);
  assert.equal(detected, true);
});

test('missing orientation cannot create lateral displacement or leave a held dodge latched', () => {
  const { state, step, clock } = lateralFixture();
  step(1);
  assert.equal(state.snapshot().action, 'dodge-right');
  state.sample({ accel: { x: -6, y: 9.81, z: 0 }, quaternion: null }, clock() + 380);
  assert.equal(state.snapshot().sideReady, false);
  assert.equal(state.snapshot().motionPhase, 'unavailable');
  assert.equal(state.snapshot().motionDirection, null);
  assert.equal(state.snapshot().side, 0);
  assert.equal(state.snapshot().action, 'stand');

  const fresh = lateralFixture();
  fresh.step(1);
  fresh.state.sample({ accel: { x: 0, y: 9.81, z: 0 }, quaternion: reference }, fresh.clock() + 380);
  assert.equal(fresh.state.snapshot().side, 0, 'the first frame after a gap is neutral');
  assert.equal(fresh.state.snapshot().sideReady, true);
  state.sample({ accel: { x: 0, y: 9.81, z: 0 }, quaternion: reference }, clock() + 400);
  assert.equal(state.snapshot().side, 0);
});

test('weightlessness is read as a jump and the landing clears it', () => {
  const state = new body.BodyState();
  idle(state, 0, 1000);
  state.sample({ accel: { x: 0, y: 0, z: 22 } }, 1020);          // push off
  state.sample({ accel: { x: 0, y: 0, z: 0.4 } }, 1060);          // airborne
  assert.equal(state.snapshot(1060).airborne, true);
  state.sample({ accel: { x: 0, y: 0, z: 24 } }, 1200);           // land
  assert.equal(state.snapshot(1200).airborne, false);
});

test('small side hops carry launch direction through flight without scoring the landing brake', () => {
  for (const [direction, action, opposite] of [[1, 'dodge-right', 'dodge-left'], [-1, 'dodge-left', 'dodge-right']]) {
    const { state, read, rest, step, clock } = lateralFixture({ enableLateralFlight: true });
    for (let i = 0; i < 7; i++) read([direction * 5.5, 0, 16.1]);
    assert.equal(state.matches(action), false, 'most of the displacement happens in the air');

    for (let i = 0; i < 9; i++) {
      assert.equal(read([0, 0, 0]).airborne, true);
      assert.equal(state.matches('jump'), false, 'a directed launch is reserved for the side cue');
    }
    assert.equal(state.matches(action), true);
    state.consume(action, clock());

    read([0, 0, 28]);
    for (let i = 0; i < 14; i++) {
      read([direction * -2.75, 0, 9.81]);
      assert.equal(state.matches(opposite), false);
      assert.equal(state.matches(action), false);
    }
    rest(8);
    step(-direction);
    assert.equal(state.matches(opposite), true, 'the next deliberate movement can score after landing');
  }
});

test('an upright jump with slight lateral noise remains a jump', () => {
  const { state, read } = lateralFixture({ enableLateralFlight: true });
  for (let i = 0; i < 7; i++) read([0.95, 0, 16.1]);
  for (let i = 0; i < 9; i++) {
    read([0, 0, 0]);
    assert.equal(state.matches('jump'), true);
    assert.equal(state.matches('dodge-left'), false);
    assert.equal(state.matches('dodge-right'), false);
  }
  read([0, 0, 28]);
  assert.equal(state.matches('jump'), false);
});

test('looking down is not a squat: the pad sits below the centre of view', () => {
  const state = new body.BodyState();
  idle(state, 0, 500);
  for (let t = 500; t < 1800; t += 20) state.sample({ accel: still, pose: { pitch: -0.55 } }, t);
  assert.equal(state.snapshot(1800).action, 'stand');
});

test('a lateral shift outranks a shallow squat but a deep squat is displayed first', () => {
  const { state: shallow, step: stepShallow } = lateralFixture();
  shallow.lift = -0.09;
  stepShallow(-1);
  assert.equal(shallow.snapshot().action, 'dodge-left');

  const { state: deep, step: stepDeep } = lateralFixture();
  deep.lift = -0.20;
  stepDeep(-1);
  assert.equal(deep.snapshot().action, 'duck');
});

test('when a squat and a fresh lateral shift overlap, the arriving cue decides', () => {
  const { state, step, read, clock } = lateralFixture();
  step(-1);
  state.lift = -0.09;
  read([0, 0, 9.81]);
  assert.equal(state.matches('duck'), true);
  assert.equal(state.matches('dodge-left'), true);
  assert.equal(state.matches('dodge-right'), false);

  const at = clock();
  const g = new core.Game({ id: 'overlap', durationMs: 4000, bpm: 120, events: [
    { id: 'd', atMs: at, action: 'duck', kind: 'note', lane: 1 },
    { id: 'l', atMs: at + 20, action: 'dodge-left', kind: 'note', lane: 2 },
  ] });
  g.start(0);
  assert.equal(g.sync(state, at).id, 'd', 'the duck cue takes the squat');
  assert.equal(g.sync(state, at + 20).id, 'l', 'the lateral cue takes the shift');
  assert.equal(g.snapshot(1800).combo, 2);
});

test('the real late step goes to its nearest right note and cannot also score the next', () => {
  const g = fixture([
    { id: 'first', atMs: 66500, action: 'dodge-right', kind: 'note', lane: 3 },
    { id: 'second', atMs: 67000, action: 'dodge-right', kind: 'note', lane: 3 },
  ].map(event => ({ ...event, atMs: event.atMs - 65000 })));
  g.start(0);
  const body = { matches: action => action === 'dodge-right', sinceFor: () => 1679 };
  assert.equal(g.next(1679).id, 'first');
  const first = g.sync(body, 1679);
  assert.equal(first.id, 'first');
  assert.equal(first.deltaMs, 179);
  assert.equal(first.grade, 'good');
  assert.equal(g.sync(body, 2000), null);
  assert.equal(g.snapshot(2000).score, 500);
});

test('a right movement 385ms early is an OK on the nearer cue, and a jump cannot score twice', () => {
  const early = fixture([{ id: 'right', atMs: 1000, action: 'dodge-right', lane: 3 }]);
  early.start(0);
  const hit = early.sync({ matches: () => true, sinceFor: () => 615 }, 615);
  assert.equal(hit.grade, 'ok');
  assert.equal(hit.deltaMs, -385);
  assert.equal(early.snapshot(615).score, 250);

  const jumps = fixture([{ id: 'a', atMs: 1000, action: 'jump', lane: 0 }, { id: 'b', atMs: 1500, action: 'jump', lane: 0 }]);
  jumps.start(0);
  const airborne = { matches: () => true, sinceFor: () => 1220 };
  assert.equal(jumps.sync(airborne, 1220).id, 'a');
  assert.equal(jumps.sync(airborne, 1230), null);
});
