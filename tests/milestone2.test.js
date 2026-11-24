import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { ACTIVE_ACTIONS, getCourse, getCourses } from '../src/lib/courses.js';
import { SERENITY_SONGS } from '../src/lib/serenity-songs.js';
import { Game } from '../src/lib/game.js';
import { RhythmAudio } from '../src/lib/audio.js';
import { render } from '../src/lib/render.js';

// ---------------------------------------------------------------- charts
test('charts are sectioned choreography on four moves with playable spacing', () => {
  for (const course of ['stretch', 'step', 'jump'].map(getCourse)) {
    assert.equal(course.sections.length, 3);
    assert.ok(course.events.length > 12);
    for (const event of course.events) {
      assert.ok(Number.isInteger(event.section) && event.section >= 0 && event.section < 3);
      assert.ok(event.atMs > 3000 && event.atMs < course.durationMs - 1000);
      assert.ok(['jump', 'duck', 'dodge-left', 'dodge-right'].includes(event.action));
    }
    for (const section of course.sections) {
      assert.ok(course.events.some(event => event.section === section.index), `${course.id} ${section.id} has cues`);
    }
    assert.ok(course.events.every(event => event.kind === 'note'), 'the first release is cues only');
  }
});

test('each level opens on its signature cue so the first beat is predictable', () => {
  const [stretch, step, jump] = ['stretch', 'step', 'jump'].map(getCourse);
  assert.equal(stretch.events[0].action, 'dodge-left');
  assert.equal(stretch.events[0].atMs, 4000);
  assert.equal(step.events[0].action, 'dodge-left');
  assert.equal(jump.events[0].action, 'jump');
  assert.equal(jump.events[0].atMs, 4000);
});

test('the three native songs use their released recordings and preserve imported note times', async () => {
  const catalog = getCourses().filter(course => course.native);
  assert.deepEqual(catalog.map(course => [course.id, course.title, course.version, course.events.length]), [
    ['beatucada', 'Beatucada', 1, 32], ['into-my-dream', 'Into My Dream', 1, 54], ['summer-overload', 'Summer Overload!', 1, 55],
  ]);
  assert.equal(new Set(catalog.flatMap(({ music, previewMusic }) => [music, previewMusic])).size, 6);
  for (const [index, course] of catalog.entries()) {
    for (const asset of [course.music, course.previewMusic]) {
      assert.ok((await stat(new URL(`../src${asset}`, import.meta.url))).size > 0, asset);
    }
    assert.equal(course.previewDurationMs, 8000);
    assert.deepEqual([...new Set(course.events.map(event => event.action))].sort(), [...ACTIVE_ACTIONS].sort());
    assert.deepEqual(course.events.map(cue => [cue.atMs, cue.action]), SERENITY_SONGS[index].notes);
    for (const [noteIndex, cue] of course.events.entries()) {
      assert.ok(cue.atMs >= 0 && cue.atMs < course.durationMs);
      if (noteIndex) assert.ok(cue.atMs - course.events[noteIndex - 1].atMs >= 850, `${course.id} movement interval`);
    }
  }
});

test('Party Sector leaves a two-beat gap for a fresh move, including same-side runs', () => {
  const course = getCourse('party-full');
  const beatMs = 60000 / course.bpm;
  assert.equal(course.events.length, 69);
  for (const [index, cue] of course.events.entries()) {
    assert.equal(cue.atMs % beatMs, 0, 'all cues still land on the recording beat');
    if (index > 0) assert.ok(cue.atMs - course.events[index - 1].atMs >= beatMs * 2);
  }
  assert.deepEqual(
    course.events.filter(cue => cue.atMs >= 52500 && cue.atMs <= 54500)
      .map(cue => [cue.atMs, cue.action]),
    [[52500, 'dodge-right'], [53500, 'dodge-right'], [54500, 'dodge-right']],
  );
});

// ---------------------------------------------------------------- judgement
function fixture() {
  const g = new Game({ id: 'fx', durationMs: 8000, bpm: 120, events: [
    { id: 'a', atMs: 1000, action: 'dodge-left', kind: 'note', lane: 2 },
    { id: 'b', atMs: 2000, action: 'jump', kind: 'note', lane: 0 },
    { id: 'c', atMs: 3000, action: 'duck', kind: 'wall', lane: 1 },
  ] });
  g.start(0); return g;
}

test('judgement records a late offset for feedback', () => {
  const g = fixture();
  assert.equal(g.sync({ action: 'dodge-left', since: 1085 }, 1085).offset, 'late');
  assert.equal(g.sync({ action: 'jump', since: 1915 }, 2000).offset, 'early');
  assert.equal(g.snapshot(1915).recent.length, 2);
});

test('combo tiers and energy rise on hits and fall on misses', () => {
  const g = fixture();
  assert.equal(g.snapshot(0).tier, 0);
  g.sync({ action: 'dodge-left', since: 500 }, 1000); g.sync({ action: 'jump', since: 1900 }, 2000);
  const warm = g.snapshot(2000);
  assert.equal(warm.tier, 0);
  assert.ok(warm.energy > 0);
  g.tick(3450);
  const after = g.snapshot(3450);
  assert.equal(after.miss, 1);
  assert.ok(after.energy < warm.energy);
  const tiers = [0, 4, 12, 24].map(combo => g.tier(combo));
  assert.deepEqual(tiers, [0, 1, 2, 3]);
});

// ---------------------------------------------------------------- audio
class BoundedContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; this.nodes = 0; this.audible = false; this.frequencies = []; }
  node() { if (++this.nodes > 16) throw new Error('audio graph capacity exceeded'); return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
  createOscillator() {
    const n = this.node(), self = this;
    const frequency = { _v: 0, setValueAtTime(v) { self.frequencies.push(v); }, get value() { return this._v; }, set value(v) { this._v = v; self.frequencies.push(v); } };
    return { ...n, frequency, type: 'sine' };
  }
  createGain() { const c = this; return { ...this.node(), gain: { value: 0, cancelScheduledValues() {}, setValueAtTime(v) { if (v > 0) c.audible = true; }, exponentialRampToValueAtTime() {} } }; }
  async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; } async close() { this.state = 'closed'; }
}

test('music layers, countdown and miss feedback all fit the bounded native graph', async () => {
  const audio = new RhythmAudio(BoundedContext); await audio.prepare();
  for (const course of getCourses()) {
    audio.setCourse(course);
    for (let beat = 0; beat < 200; beat++) {
      audio.context.currentTime = beat * (60 / course.bpm);
      audio.tick(beat * 60000 / course.bpm, course.bpm, beat % 30, beat < 20 ? 0 : 2);
      audio.feedback(['perfect', 'good', 'miss'][beat % 3]);
    }
    audio.context.state = 'suspended'; audio.lastCountdown = -1;
    for (let n = 3; n > 0; n--) audio.countdown(n);
  }
  assert.equal(audio.context.audible, true);
  assert.ok(audio.context.frequencies.length > 100);
  await audio.close();
});

// ---------------------------------------------------------------- renderer
function stubContext() {
  const calls = [];
  const noop = name => (...args) => calls.push(name);
  const ctx = {
    calls,
    clearRect: noop('clearRect'), fillRect: noop('fillRect'), beginPath: noop('beginPath'),
    moveTo: noop('moveTo'), lineTo: noop('lineTo'), arc: noop('arc'), arcTo: noop('arcTo'),
    quadraticCurveTo: noop('quadraticCurveTo'), ellipse: noop('ellipse'), closePath: noop('closePath'),
    fill: noop('fill'), stroke: noop('stroke'), save: noop('save'), restore: noop('restore'),
    translate: noop('translate'), scale: noop('scale'), rotate: noop('rotate'), fillText: (s, x, y) => calls.push(['fillText', String(s), x, y]),
    strokeRect: noop('strokeRect'),
  };
  for (const key of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'lineCap', 'lineJoin']) ctx[key] = '';
  return ctx;
}

test('every screen draws without throwing and shows the chart cues', () => {
  const courses = getCourses();
  const home = stubContext(); render(home, { mode: 'home', courses, selected: 1, now: 0 });
  assert.ok(home.calls.some(call => Array.isArray(call) && call[1] === '踏拍穿行'));
  const calibrating = stubContext(); render(calibrating, { mode: 'calibrating', courses, selected: 0, countdown: 2, source: 'imu' });
  const error = stubContext(); render(error, { mode: 'sensor-error', courses, selected: 0, message: '无信号' });

  const game = new Game(courses[0]); game.start(0);
  const first = courses[0].events[0];
  game.input(first.action, first.atMs); game.tick(first.atMs + 300);
  const playing = stubContext(); render(playing, { mode: 'playing', courses, selected: 0, state: game.snapshot(first.atMs + 300), now: first.atMs + 300 });
  assert.ok(playing.calls.some(call => Array.isArray(call) && call[1] === 'COMBO 1'));

  const paused = stubContext(); render(paused, { mode: 'paused', courses, selected: 0, state: game.snapshot(12000) });
  assert.ok(paused.calls.some(call => Array.isArray(call) && call[1] === '已暂停'));

  const finished = new Game(courses[0]); finished.start(0); finished.tick(courses[0].durationMs);
  const result = stubContext(); render(result, { mode: 'result', courses, selected: 0, state: finished.snapshot(courses[0].durationMs), saved: '成绩已同步' });
  assert.ok(result.calls.some(call => Array.isArray(call) && call[1] === '成绩已同步'));
});
