import test from 'node:test';
import assert from 'node:assert/strict';
import { getCourse, LANE_BY_ACTION } from '../src/lib/courses.js';
import { createTutorialCourse, TutorialJump, TUTORIAL_ACTIONS, TUTORIAL_DEMO_MS, tutorialCue } from '../src/lib/tutorial.js';

test('tutorial rehearsal has no recording and does not change the shared charts', () => {
  const practice = getCourse('practice');
  const tutorial = createTutorialCourse();
  assert.equal(tutorial.music, undefined);
  assert.ok(practice.music);
  assert.equal(tutorial.bpm, 120);
  assert.equal(tutorial.durationMs, 20000);
  tutorial.events.push(tutorialCue(TUTORIAL_ACTIONS[0]));
  assert.equal(createTutorialCourse().events.length, 0);
  assert.ok(practice.events.every(cue => !cue.id.startsWith('tutorial-')));
});

test('each action begins after its full demonstration, independent of the beat', () => {
  let elapsedMs = 0;
  const cues = TUTORIAL_ACTIONS.map(action => {
    const cue = tutorialCue(action, elapsedMs);
    elapsedMs = cue.atMs + 400;
    assert.equal(cue.lane, LANE_BY_ACTION.get(action));
    return cue;
  });
  assert.deepEqual(cues.map(cue => cue.atMs), [TUTORIAL_DEMO_MS, 2 * TUTORIAL_DEMO_MS + 400, 3 * TUTORIAL_DEMO_MS + 800]);
});

test('a light hop survives the low-load tail and is confirmed on landing', () => {
  // Shaped from the short hop at 42s in the physical ee4abde3 tutorial.
  const readings = [[0, 9.8], [35, 12.2], [65, 19], [110, 13.1], [183, 10.3], [243, 2.7],
    [263, 1.2], [298, 1.5], [303, 1.4], [323, 1.4], [357, 1.7], [363, 2.8], [384, 4.2],
    [411, 6.3], [424, 8.8], [484, 9.4], [527, 10.6], [545, 13.3]];
  const jump = new TutorialJump();
  const outcomes = readings.map(([now, load]) => jump.sample({ x: 0, y: 0, z: load }, now, false)).filter(Boolean);
  assert.deepEqual(outcomes, [{ accepted: true, reason: 'confirmed', airMs: 134.5, landing: 13.3 }]);
});

test('a repeated timestamp and a side hop cannot complete the upward exercise', () => {
  const jump = new TutorialJump();
  const measure = (at, load, sensorTimestamp = at, sideways = false) => jump.sample({ x: 0, y: 0, z: load, sensorTimestamp }, at, sideways);
  assert.equal(measure(0, 16), null);
  for (let at = 20; at < 180; at += 20) assert.equal(measure(at, 0.5, 20), null);
  assert.equal(measure(180, 18), null, 'duplicate readings do not stretch a single near-zero sample into a hop');
  for (let at = 200; at < 420; at += 20) assert.equal(measure(at, 0.5, at, true), null);
  assert.equal(measure(420, 18), null);
});
