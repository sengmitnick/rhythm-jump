import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSpatial, padScreens, noteScreen } from '../src/lib/spatial-render.js';
import { GLASSES_INK } from '../src/lib/render.js';
import { Game, PERFECT_MS, GOOD_MS, OK_MS } from '../src/lib/game.js';
import { getCourses, LANE_BY_ACTION } from '../src/lib/courses.js';
import { menuTargets } from '../src/lib/menu-navigation.js';
import { TUTORIAL_DEMO_MS } from '../src/lib/tutorial.js';

// Fail on browser-only methods and color formats, rather than letting a loose
// mock hide an unsupported native call. These are the documented AIUI Canvas
// primitives used by this renderer and its existing menu/result fallback.
function nativeContext() {
  const calls = [], strokes = [], texts = [], textPaints = [], rectFills = [], pathFills = [], stack = [], rotations = [];
  const nativePaths = [];
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1 };
  let path = [], gradientCount = 0, flushCount = 0;
  const validColor = value => value === '#000000' || value === '#40ff5e' ||
    (typeof value === 'string' && /^rgba\(64,255,94,(?:0(?:\.\d+)?|1(?:\.0+)?)\)$/.test(value));
  const numeric = args => args.forEach(value => assert.ok(typeof value === 'number' && Number.isFinite(value), `finite Canvas coordinate: ${value}`));
  const gradient = (...args) => {
    numeric(args); gradientCount++;
    return { nativeGradient: true, addColorStop(offset, color) { assert.ok(offset >= 0 && offset <= 1); assert.ok(validColor(color), `native gradient color ${color}`); } };
  };
  const methods = {
    beginPath() { path = []; },
    moveTo(...args) { numeric(args); path.push(['moveTo', ...args]); },
    lineTo(...args) { numeric(args); path.push(['lineTo', ...args]); },
    arc(...args) { numeric(args); assert.ok(args[2] >= 0); path.push(['arc', ...args]); },
    ellipse(...args) { numeric(args); assert.ok(args[2] >= 0 && args[3] >= 0); path.push(['ellipse', ...args]); },
    quadraticCurveTo(...args) { numeric(args); path.push(['quadraticCurveTo', ...args]); },
    closePath() {}, clip() {},
    fill() {
      const points = path.flatMap(([method, x, y, a, b]) => {
        if (method === 'arc') return [[x - a, y - a], [x + a, y + a]];
        if (method === 'ellipse') return [[x - a, y - b], [x + a, y + b]];
        if (method === 'quadraticCurveTo') return [[x, y], [a, b]];
        return [[x, y]];
      });
      if (!points.length) return;
      const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
      pathFills.push({ color: state.fillStyle, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    },
    stroke(compiled) {
      if (compiled) nativePaths.push(compiled);
      strokes.push({ path: structuredClone(compiled?.commands ?? path), color: state.strokeStyle, width: state.lineWidth, alpha: state.globalAlpha });
    },
    fillRect(...args) { numeric(args); rectFills.push({ bounds: args, color: state.fillStyle, alpha: state.globalAlpha }); },
    strokeRect(...args) { numeric(args); }, clearRect(...args) { numeric(args); },
    translate(...args) { numeric(args); }, scale(...args) { numeric(args); }, rotate(...args) { numeric(args); rotations.push(args[0]); },
    fillText(value, ...args) { numeric(args); texts.push(String(value)); textPaints.push({ value: String(value), color: state.fillStyle, x: args[0], y: args[1] }); },
    save() { stack.push({ ...state }); }, restore() { assert.ok(stack.length, 'balanced native restore'); Object.assign(state, stack.pop()); },
    createLinearGradient: gradient, createRadialGradient: gradient,
    flush() { flushCount++; },
  };
  const ctx = new Proxy({}, {
    get(_, key) {
      if (key in methods) return (...args) => { calls.push(key); return methods[key](...args); };
      if (key in state) return state[key];
      throw Error(`Unsupported native Canvas method/property ${String(key)}`);
    },
    set(_, key, value) {
      assert.ok(key in state, `supported native Canvas property ${String(key)}`);
      if (key === 'fillStyle' || key === 'strokeStyle') assert.ok(validColor(value) || value?.nativeGradient, `native style ${String(value)}`);
      state[key] = value; return true;
    },
  });
  return { ctx, calls, strokes, texts, textPaints, rectFills, pathFills, rotations, nativePaths, metrics: () => ({ gradientCount, flushCount, saveDepth: stack.length }) };
}

function model(action = 'dodge-left', elapsedMs = 1000, kind = 'note') {
  const lane = LANE_BY_ACTION.get(action);
  const course = { ...getCourses()[0], events: [{ id: 'native-cue', action, kind, lane, atMs: elapsedMs + 450 }] };
  const game = new Game(course); game.start(0); game.tick(elapsedMs);
  return { mode: 'playing', courses: [course], selected: 0, state: game.snapshot(elapsedMs) };
}

test('native spatial gameplay supports all cues without keyboard labels or obstacle instructions', () => {
  for (const action of ['jump', 'dodge-left', 'dodge-right']) {
    const capture = nativeContext(); renderSpatial(capture.ctx, model(action));
    assert.ok(capture.calls.includes('lineTo'), `${action} tunnel/icon rendered`);
    assert.ok(capture.strokes.length >= 10, `${action} stage geometry rendered`);
    assert.ok(capture.texts.includes('COMBO'));
    assert.equal(capture.texts.some(value => ['D', 'F', 'J', 'K'].includes(value)), false);
    assert.equal(capture.texts.some(value => /下蹲|左闪|右闪|避让|左手|右手|左脚|右脚/.test(value)), false);
    assert.deepEqual(capture.metrics(), { gradientCount: 0, flushCount: 1, saveDepth: 0 });
    assert.ok(capture.calls.length < 900, `${action} drawing remains bounded`);
  }
});

test('a steady view reuses native rail paths without shifting the stage or repainting the rails differently', t => {
  class NativePath {
    commands = [];
    moveTo(...coordinates) { this.commands.push(['moveTo', ...coordinates]); }
    lineTo(...coordinates) { this.commands.push(['lineTo', ...coordinates]); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Path2D');
  Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: NativePath });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Path2D', original);
    else delete globalThis.Path2D;
  });
  const frame = model();
  const draw = yaw => {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { ...frame, pose: { yaw, pitch: 0.12, valid: true } });
    return capture;
  };
  const first = draw(0.4), prepared = draw(0.5), reused = draw(0.6);
  assert.equal(first.nativePaths.length, 0);
  assert.equal(reused.nativePaths.length, 2);
  assert.equal(reused.nativePaths[0], prepared.nativePaths[0]);
  assert.equal(reused.nativePaths[1], prepared.nativePaths[1]);
  assert.deepEqual(reused.strokes, first.strokes);
  assert.equal(first.calls.length - reused.calls.length, 20);
  assert.equal(reused.metrics().flushCount, 1);

  const turned = draw(-0.4);
  assert.equal(turned.nativePaths.length, 0);
  assert.notDeepEqual(turned.strokes[0], first.strokes[0]);
  assert.deepEqual(draw(-0.5).strokes, turned.strokes);
});

test('the arm the body is currently in is drawn brighter than the others', () => {
  for (const action of ['jump', 'dodge-left', 'dodge-right']) {
    const capture = nativeContext();
    const frame = model('jump');
    frame.state.next = null;
    renderSpatial(capture.ctx, { ...frame, body: { action, side: 0, lift: 0, airborne: action === 'jump' } });
    const active = capture.strokes.filter(stroke => stroke.color === GLASSES_INK.text && stroke.width === 1.6);
    assert.equal(active.length, 1, `${action} lights exactly one arm`);
    const corners = active[0].path.map(command => [command[1], command[2]]);
    const cx = corners.reduce((sum, point) => sum + point[0], 0) / corners.length;
    const cy = corners.reduce((sum, point) => sum + point[1], 0) / corners.length;
    const pad = padScreens()[LANE_BY_ACTION.get(action)];
    assert.ok(Math.hypot(cx - pad.x, cy - pad.y) < 25, `${action} lights its own arm`);
  }
});

test('left, jump and right share the same judgement line', () => {
  const screens = padScreens();
  assert.equal(screens.filter(Boolean).length, 3);
  for (const point of screens.filter(Boolean)) {
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x > 60 && point.x < 420);
    assert.ok(point.y > 100 && point.y < 330, 'pads sit inside the view');
  }
  const [up, down, left, right] = screens;
  assert.equal(down, null, 'the disabled squat keeps its lane index but has no projected pad');
  assert.equal(up.depth, left.depth, 'the center jump pad shares the sides’ world depth');
  assert.ok(left.x < up.x - 40 && right.x > up.x + 40, 'side arms frame the column');
  assert.equal(up.y, left.y);
  assert.equal(up.y, right.y);
});

test('the next action previews three nested timing zones and lights the applicable zone', () => {
  const frame = model('jump');
  const [jump] = frame.state.events;
  frame.state.events.push({ ...jump, id: 'after-jump', action: 'dodge-left', lane: 2, atMs: jump.atMs + 100 });
  const drawAt = delta => {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { ...frame, state: { ...frame.state, elapsedMs: jump.atMs - delta } });
    return capture;
  };
  const prep = drawAt(450), onBeat = drawAt(0);
  const label = capture => capture.textPaints.find(paint => paint.value === '起跳');
  const zone = capture => capture.strokes.find(stroke => stroke.color === GLASSES_INK.bright && stroke.width === 2.1 && stroke.path.length === 4);
  const span = stroke => Math.abs(stroke.path[1][1] - stroke.path[0][1]);
  assert.equal(label(drawAt(800)), undefined);
  assert.equal(label(prep).color, GLASSES_INK.text);
  assert.equal(zone(prep), undefined);
  assert.ok([0.8, 1, 1.3].every(width => prep.strokes.some(stroke => stroke.width === width && stroke.path.length === 4)));
  assert.equal(label(onBeat).color, GLASSES_INK.bright);
  const outer = zone(drawAt(OK_MS)), middle = zone(drawAt(GOOD_MS)), inner = zone(drawAt(PERFECT_MS));
  assert.ok(span(outer) > span(middle) && span(middle) > span(inner));
  assert.ok(!onBeat.texts.includes('左跨'), 'later arrows do not compete for the action label');
  assert.deepEqual(zone(drawAt(-OK_MS)).path, outer.path, 'the late outer window occupies the same region');
  assert.equal(label(drawAt(-OK_MS - 1)), undefined);
  const markerY = capture => capture.strokes.find(stroke => stroke.width === 2.6 && stroke.path.length === 2).path[0][2];
  assert.ok(markerY(drawAt(OK_MS)) < markerY(onBeat));
  assert.ok(markerY(onBeat) < markerY(drawAt(-OK_MS)), 'the arrow marker continues through the late half');
  for (const [action, prompt] of [['dodge-left', '左跨'], ['dodge-right', '右跨']]) {
    const side = model(action);
    side.state.elapsedMs = side.state.events[0].atMs - 220;
    const capture = nativeContext();
    renderSpatial(capture.ctx, side);
    assert.ok(capture.texts.includes(prompt));
  }
});

test('Perfect, Good, OK and Miss resolve around the judged pad with distinct local feedback', () => {
  const frame = model();
  const [event] = frame.state.events;
  frame.state.done.add(event.id);
  const judge = (grade, age = 0) => {
    const capture = nativeContext();
    const last = { atMs: event.atMs, action: event.action, lane: event.lane, grade, offset: 'late' };
    renderSpatial(capture.ctx, { ...frame, state: { ...frame.state, elapsedMs: event.atMs + age, last } });
    return capture;
  };
  const perfect = judge('perfect'), good = judge('good'), ok = judge('ok'), miss = judge('miss');
  const pad = padScreens()[event.lane];
  const paint = perfect.textPaints.find(item => item.value === 'PERFECT');
  assert.ok(Math.abs(paint.x - pad.x) < 6 && paint.y > pad.y, 'judgement stays below its pad and out of the oncoming arrow');
  assert.ok(perfect.texts.includes('+1000'));
  assert.ok(good.texts.includes('+500 · 稍晚'));
  assert.ok(ok.texts.includes('OK') && ok.texts.includes('+250 · 稍晚'));
  assert.ok(miss.texts.includes('MISS') && miss.texts.every(text => !text.startsWith('+')));
  const pulse = (capture, color, width) => capture.strokes.find(stroke => stroke.color === color && stroke.width === width);
  const burst = pulse(perfect, GLASSES_INK.bright, 3);
  assert.ok(burst && pulse(good, GLASSES_INK.text, 2.05));
  assert.ok(pulse(ok, GLASSES_INK.secondary, 1.65));
  assert.equal(pulse(miss, GLASSES_INK.bright, 3), undefined);
  assert.ok(!perfect.strokes.some(stroke => stroke.color === GLASSES_INK.bright &&
    stroke.path.some(([, x]) => x < 5 || x > 475)), 'no perimeter flash');
  assert.ok(!judge('perfect', 460).texts.includes('PERFECT'), 'feedback clears after its short lifetime');
});

test('consecutive notes in one lane separate the next action prompt and the last grade', () => {
  const frame = model('dodge-left');
  const previous = frame.state.events[0];
  const next = { ...previous, id: 'next-left', atMs: previous.atMs + 500 };
  frame.state.events = [previous, next];
  frame.state.next = next;
  frame.state.done.add(previous.id);
  frame.state.elapsedMs = previous.atMs + 120;
  frame.state.last = { ...previous, atMs: previous.atMs, grade: 'perfect' };
  const capture = nativeContext();
  renderSpatial(capture.ctx, frame);
  const action = capture.textPaints.find(item => item.value === '左跨');
  const grade = capture.textPaints.find(item => item.value === 'PERFECT');
  assert.ok(action && grade && grade.y - action.y >= 18);
});

test('head turns move the stage slightly and keep all three pads in view', () => {
  const neutral = padScreens();
  const turnedRight = padScreens({ yaw: 0.25, pitch: 0, valid: true });
  for (const lane of [0, 2, 3]) {
    const dx = turnedRight[lane].x - neutral[lane].x, dy = turnedRight[lane].y - neutral[lane].y;
    assert.ok(dx < -15 && dx > -30, 'turning right slides the floor slightly left');
    assert.ok(Math.abs(dx) > Math.abs(dy) * 3, 'yaw dominates the floor shift');
  }
  const down = padScreens({ yaw: 0, pitch: -0.35, valid: true });
  for (const lane of [0, 2, 3]) {
    const dy = down[lane].y - neutral[lane].y;
    assert.ok(dy < -12 && dy > -25, 'looking down lifts the pads slightly');
  }
  for (const yaw of [-1, 1]) {
    for (const pitch of [-1, 1]) {
      for (const point of padScreens({ yaw, pitch, valid: true }).filter(Boolean)) {
        assert.ok(point.x > 60 && point.x < 420 && point.y > 100 && point.y < 330);
      }
    }
  }
  const invalid = padScreens({ yaw: 0.25, pitch: 0.4, valid: false });
  for (const lane of [0, 2, 3]) {
    assert.ok(Math.abs(invalid[lane].x - neutral[lane].x) < 0.001);
    assert.ok(Math.abs(invalid[lane].y - neutral[lane].y) < 0.001);
  }
});

test('targets fly in from the tunnel and land on their own pad arm', () => {
  const event = { id: 'approach', atMs: 5000, action: 'jump', kind: 'note', lane: 0 };
  const far = noteScreen(event, 2500), near = noteScreen(event, 5000);
  assert.ok(far && near);
  assert.ok(near.scale > far.scale * 1.7, 'the target grows as it approaches');
  assert.ok(near.y > far.y + 60, 'the target descends toward the floor pad');
  const pad = padScreens()[0];
  assert.ok(Math.abs(near.x - pad.x) < 12, 'the landing arm matches the pad');
  assert.ok(near.y < pad.y && pad.y - near.y < 40, 'the target meets the pad at cue time');
  // A side cue lands on its own arm instead of the centre column.
  const side = noteScreen({ ...event, id: 'side', action: 'dodge-right', lane: 3 }, 5000);
  const farSide = noteScreen({ ...event, id: 'side', action: 'dodge-right', lane: 3 }, 2500);
  assert.ok(side.x > near.x + 40, 'side moves land on the side arms');
  assert.ok(farSide.x > far.x + 20, 'perspective separates approaching lanes before the hit');
  assert.equal(side.depth, near.depth);
});

test('approaching arrows shear with stage yaw and show a second outline only at useful depths', () => {
  const frame = model('jump');
  const capture = nativeContext(), yawed = nativeContext(), far = nativeContext();
  renderSpatial(capture.ctx, frame);
  renderSpatial(yawed.ctx, { ...frame, pose: { yaw: 0.35, pitch: 0, valid: true } });
  renderSpatial(far.ctx, { ...frame, state: { ...frame.state, elapsedMs: 0,
    events: [{ ...frame.state.events[0], atMs: 2900 }], next: null } });
  const face = (result, color = GLASSES_INK.bright) => result.strokes.find(stroke => stroke.color === color && stroke.path.length === 7);
  const side = result => result.strokes.find(stroke => stroke.color === GLASSES_INK.frame && stroke.width === 0.85 && stroke.path.length === 13);
  const neutralFace = face(capture), yawedFace = face(yawed);
  assert.ok(neutralFace && yawedFace && face(far, GLASSES_INK.secondary));
  assert.ok(side(capture) && side(yawed), 'near arrows have a back edge and depth connectors');
  assert.equal(side(far), undefined, 'small far arrows use only the front silhouette');
  const [, tipX] = yawedFace.path[0];
  const [, shoulderX] = yawedFace.path[1];
  const [, oppositeShoulderX] = yawedFace.path[6];
  const shear = Math.abs(tipX - (shoulderX + oppositeShoulderX) / 2);
  assert.ok(shear > 0.01, 'head yaw shears the projected polygon');
  assert.ok(neutralFace.path[0][1] - tipX > 15, 'larger turns retain visible parallax');
  assert.ok(Math.abs(neutralFace.path[0][1] - (neutralFace.path[1][1] + neutralFace.path[6][1]) / 2) < 0.01);
});

test('a disabled squat estimate, stale hit or cue cannot reintroduce a fourth frame', () => {
  const frame = model('duck');
  const duck = frame.state.events[0];
  assert.equal(noteScreen(duck, duck.atMs), null);
  const noCue = { ...frame, state: { ...frame.state, events: [], next: null }, body: { action: 'stand', side: 0, lift: 0 } };
  const baseline = nativeContext();
  renderSpatial(baseline.ctx, noCue);
  for (const kind of ['note', 'wall']) {
    const capture = nativeContext();
    const stale = { ...frame.state, events: [{ ...duck, kind }], last: { ...duck, atMs: frame.state.elapsedMs, grade: 'perfect' } };
    renderSpatial(capture.ctx, { ...frame, state: stale, body: { action: 'duck', side: 0, lift: 0 } });
    assert.deepEqual(capture.strokes, baseline.strokes, `${kind} and body state do not add an outline`);
    assert.deepEqual(capture.texts, baseline.texts, 'no stale hit label');
  }
});

test('walls grow into solid occluders as they reach the player', () => {
  for (const action of ['dodge-left', 'dodge-right', 'jump']) {
    const frame = model(action, 2000, 'wall');
    const [obstacle] = frame.state.events;
    frame.state.elapsedMs = obstacle.atMs;
    const capture = nativeContext();
    renderSpatial(capture.ctx, frame);
    assert.ok(capture.pathFills.some(fill => fill.color === GLASSES_INK.black && fill.width > 240 && fill.height > 70), `${action} occludes the corridor`);
    assert.ok(capture.pathFills.every(fill => fill.color === GLASSES_INK.black || fill.width < 60 || fill.height < 24), `${action} does not paint a luminous slab`);
  }
});

test('native renderer flushes once per frame including pause and countdown', () => {
  const capture = nativeContext(), playing = model();
  renderSpatial(capture.ctx, playing); renderSpatial(capture.ctx, playing);
  renderSpatial(capture.ctx, { ...playing, mode: 'paused' });
  renderSpatial(capture.ctx, { ...playing, mode: 'calibrating', countdown: 2, source: 'imu' });
  assert.deepEqual(capture.metrics(), { gradientCount: 0, flushCount: 4, saveDepth: 0 });
  assert.ok(capture.texts.includes('已暂停'));
  assert.ok(capture.texts.includes('正视前方站稳'));
  assert.ok(capture.texts.includes('返回键回到主菜单'));
});

test('the independent calibration guide stays put as the head moves', () => {
  const neutral = nativeContext(), turned = nativeContext();
  const frame = { mode: 'calibrating', source: 'imu', stand: { still: 0.5 } };
  renderSpatial(neutral.ctx, frame);
  renderSpatial(turned.ctx, { ...frame, pose: { yaw: 0.35, pitch: -0.2, valid: true } });
  assert.deepEqual(turned.strokes, neutral.strokes);
});

test('initial calibration and saved-pose checking use only their own copy and measured progress', () => {
  const session = model('dodge-left');
  for (const [step, label] of [['capture', '姿态校准'], ['checking', '检测姿态']]) {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { ...session, mode: 'calibrating', tutorial: { action: 'dodge-left' },
      stand: { step, still: 0.75, hint: '保持正对前方' }, message: '正在采集传感器样本' });
    assert.deepEqual(capture.texts, [label, '正视前方站稳', '保持正对前方', '正在采集传感器样本', '返回键回到主菜单']);
    assert.ok(capture.strokes.some(({ path, width }) => width === 2 &&
      path[0]?.[0] === 'moveTo' && path[0][1] === 154 && path[1]?.[1] === 283 && path[1][2] === 235));
  }
});

test('main menu aligns three song panels and two modules with the gaze targets', () => {
  const songs = getCourses().filter(song => song.native);
  assert.equal(songs.length, 3);
  const labels = [...songs.map(song => song.title), '排行榜', '新手教程'];
  for (const [selected, target] of menuTargets(songs.length).entries()) {
    const capture = nativeContext();
    const songIndex = target.index >= 0 ? target.index : 0;
    renderSpatial(capture.ctx, { mode: 'home', menu: { songs, songIndex, focus: target.focus } });
    assert.deepEqual(capture.textPaints.filter(paint => labels.includes(paint.value) && paint.color === GLASSES_INK.bright).map(paint => paint.value), [labels[selected]]);
    for (const [index, bounds] of menuTargets(songs.length).entries()) {
      const label = capture.textPaints.find(item => item.value === labels[index]);
      assert.ok(label.x > bounds.x && label.x < bounds.x + bounds.w);
      assert.ok(label.y > bounds.y && label.y < bounds.y + bounds.h);
    }
    assert.ok(capture.texts.includes('122 BPM  ·  1:48  ·  Kurio Prokos'));
    assert.ok(capture.texts.includes('滑动切换 · 单击确认'));
    assert.ok(capture.texts.includes('也可看向目标并停留'));
  }
});

test('menu preview progress and partially completed gaze dwell have separate visual feedback', () => {
  const songs = getCourses().filter(song => song.native);
  const capture = nativeContext();
  renderSpatial(capture.ctx, { mode: 'home', menu: {
    songs, focus: 'song', songIndex: 0, previewPlaying: true, previewProgress: 0.5,
    cursor: { x: 76, y: 110 }, dwellProgress: 0.25,
  } });
  assert.ok(capture.texts.includes('试听中'));
  assert.ok(capture.strokes.some(({ color, path }) => color === GLASSES_INK.bright &&
    path[0]?.[0] === 'moveTo' && path[0][1] === 217 && path[1]?.[1] === 244), 'progress covers half the preview rail');
  assert.ok(capture.strokes.some(({ color, path }) => color === GLASSES_INK.bright &&
    path[0]?.[0] === 'arc' && path[0][1] === 76 && path[0][2] === 110 && path[0][4] === -Math.PI / 2 && path[0][5] === 0), 'dwell arc covers a quarter of the reticle');
});

test('tutorial shows one fixed target and confirms a movement without timed misses or song scoring', () => {
  const draw = (tutorial, state) => {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { mode: 'tutorial', tutorial, state });
    return capture;
  };
  const state = model('dodge-left').state;
  const ready = { action: 'dodge-left', phase: 'ready' };
  const first = draw(ready);
  for (const copy of ['新手教程', '1 / 3', '左跨 · 轮到你', '左脚向左迈一小步', '身体跟着移过去', '双击返回主菜单']) {
    assert.ok(first.texts.includes(copy));
  }
  const longWait = draw({ ...ready, phaseElapsedMs: 120000 }, { ...state, elapsedMs: 120000, last: { grade: 'miss' } });
  const targets = capture => capture.strokes.filter(({ path, color }) => color === GLASSES_INK.bright && path.length === 7);
  assert.equal(targets(first).length, 1);
  assert.deepEqual(longWait.strokes, first.strokes);
  assert.deepEqual(longWait.texts, first.texts);

  const repeat = draw({ ...ready, attempt: 2 });
  assert.ok(repeat.texts.includes('左跨 · 再做一次'));
  const jump = draw({ ...ready, action: 'jump', index: 2 }, state);
  for (const copy of ['原地轻跳，双脚离地', '落地站稳']) assert.ok(jump.texts.includes(copy));
  const help = draw({ ...ready, action: 'jump', hint: '双脚同时离地' });
  assert.ok(help.texts.includes('双脚同时离地'));
  assert.ok(!help.texts.includes('落地站稳'));

  const success = draw({ ...ready, phase: 'success', phaseElapsedMs: 100 }, { ...state, last: { grade: 'perfect' } });
  assert.ok(success.texts.includes('GOOD'));
  const completed = draw({ ...ready, phase: 'success', action: 'jump', index: 2, completed: true });
  for (const copy of ['3 / 3', 'GOOD', '教程完成', '接下来可以开始正式曲目', '双击返回主菜单']) {
    assert.ok(completed.texts.includes(copy));
  }
  for (const capture of [first, longWait, repeat, jump, help, success, completed]) {
    assert.ok(capture.texts.every(value => !['COMBO', 'SCORE', 'PERFECT', 'MISS'].includes(value) &&
      !/^\d+:\d\d$|^\+/.test(value)));
    assert.equal(capture.metrics().flushCount, 1);
  }
});

test('tutorial shows a safe standing setup and requires an explicit temple tap instruction', () => {
  const capture = nativeContext();
  renderSpatial(capture.ctx, { mode: 'tutorial-ready' });
  for (const label of ['先站稳，再开始', '找一块空旷、防滑的地方', '站起来，面向正前方', '单击镜腿开始', '返回键回到主菜单']) {
    assert.ok(capture.texts.includes(label));
  }
  assert.equal(capture.textPaints.find(item => item.value === '单击镜腿开始').color, GLASSES_INK.bright);
  assert.equal(capture.metrics().flushCount, 1);
});

test('tutorial figure demonstrates a one-foot lateral step with an upper-body lean and a two-foot jump', () => {
  function figureAt(action, progress) {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { mode: 'tutorial', tutorial: { action, phase: 'demo', phaseElapsedMs: TUTORIAL_DEMO_MS * progress } });
    assert.ok(capture.texts.some(value => value.endsWith('看示范')));
    const figure = capture.strokes.find(({ path }) => path[0]?.[0] === 'arc' && path[0][3] === 6);
    assert.ok(figure, `drew the ${action} demo`);
    const [, x, y] = figure.path[0];
    const toes = figure.path.filter(([op, px, py], index, segments) => {
      const previous = segments[index - 1];
      return op === 'lineTo' && previous?.[0] === 'lineTo' && previous[2] === py && Math.abs(px - previous[1]) === 5;
    });
    return { x, y, hip: figure.path[2][1], toes };
  }
  for (const [action, direction] of [['dodge-left', -1], ['dodge-right', 1]]) {
    const ready = figureAt(action, 0);
    const stepping = figureAt(action, 0.34);
    const landed = figureAt(action, 0.85);
    assert.equal(stepping.toes.filter(([, , y]) => y === 201).length, 1, 'one foot stays planted through the step');
    assert.equal((landed.hip - ready.hip) * direction, 12);
    assert.ok((landed.x - landed.hip) * direction > 5, 'head and upper torso tilt toward the stepping foot');
    assert.ok(landed.y > ready.y, 'the grounded side demo does not bounce upward');
    const toeShifts = landed.toes.map(([, x, y], index) => [x - ready.toes[index][1], y]);
    assert.deepEqual(toeShifts, direction < 0 ? [[-18, 201], [0, 201]] : [[0, 201], [18, 201]]);
  }
  const ready = figureAt('jump', 0);
  const airborne = figureAt('jump', 0.465);
  assert.equal(airborne.x, ready.x);
  assert.ok(ready.y - airborne.y > 20);
  assert.ok(airborne.toes.length === 2 && airborne.toes.every(([, , y]) => 201 - y > 20));
});

test('formal play and tutorial show the lower-left motion diagnostics only when enabled', () => {
  const frame = model('jump');
  for (const mode of ['playing', 'tutorial']) {
    for (const [motionDirection, motionPhase, label] of [
      ['dodge-left', 'moving', '左移 · 移动中'],
      ['dodge-right', 'settling', '右移 · 回稳中'],
      ['dodge-right', 'ready', '右移 · 已回稳'],
      [null, 'ready', '侧移就绪'],
      [null, 'moving', '检测侧移中'],
      [null, 'unavailable', '动作信号不可用'],
    ]) {
      const input = { ...frame, mode, tutorial: { action: 'jump', phase: 'ready' }, body: { side: -999, motionDirection, motionPhase } };
      const enabled = nativeContext(), disabled = nativeContext(), defaultView = nativeContext();
      renderSpatial(enabled.ctx, { ...input, showMotionDebug: true });
      renderSpatial(disabled.ctx, { ...input, showMotionDebug: false });
      renderSpatial(defaultView.ctx, input);
      const status = enabled.textPaints.find(item => item.value === label);
      assert.ok(status?.x < 60 && status.y > 315, `${mode}: ${label} stays at the lower left`);
      assert.equal(enabled.textPaints.filter(item => item.x === status.x && item.y === status.y).length, 1);
      assert.deepEqual(disabled.textPaints, enabled.textPaints.filter(item => item !== status));
      assert.deepEqual(defaultView.textPaints, disabled.textPaints);
    }
  }
});

test('native menu, error and result remain complete without a DOM overlay', () => {
  const courses = getCourses(), playing = model();
  const capture = nativeContext();
  renderSpatial(capture.ctx, { mode: 'home', courses, selected: 0 });
  renderSpatial(capture.ctx, { mode: 'sensor-error', message: '传感器未连接' });
  renderSpatial(capture.ctx, { ...playing, mode: 'result', saved: '成绩已保存在眼镜' });
  assert.ok(capture.texts.includes('节奏开跳'));
  assert.ok(capture.texts.includes('暂未收到动作信号'));
  assert.ok(capture.texts.includes('成绩已保存在眼镜'));
  assert.equal(capture.metrics().flushCount, 3);
  assert.equal(capture.metrics().saveDepth, 0);
});

test('native result highlights the selected replay, leaderboard or menu action', () => {
  const labels = ['再跳一次', '排行榜', '回到主菜单'];
  for (let resultAction = 0; resultAction < labels.length; resultAction++) {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { ...model(), mode: 'result', resultAction });
    for (let i = 0; i < labels.length; i++) {
      assert.ok(capture.texts.includes(labels[i]));
      const paint = capture.textPaints.find(item => item.value === labels[i]);
      assert.equal(paint.color, i === resultAction ? GLASSES_INK.bright : GLASSES_INK.text);
    }
    assert.ok(capture.texts.includes('滑动选择 · 单击确认'));
    assert.equal(capture.strokes.filter(stroke => stroke.color === GLASSES_INK.bright && stroke.width === 1.7).length, 1);
    assert.deepEqual(capture.metrics(), { gradientCount: 0, flushCount: 1, saveDepth: 0 });
  }
});

test('native screens have a pure black floor without gradients or large luminous fills', () => {
  const playing = model('duck', 2000);
  const [obstacle] = playing.state.events;
  playing.state.elapsedMs = obstacle.atMs; // Near wall occupies its largest visible area.
  const screens = [
    { mode: 'home', courses: getCourses(), selected: 2 },
    { mode: 'tutorial-ready' },
    { ...playing, mode: 'calibrating', countdown: 2 },
    playing,
    { ...playing, mode: 'paused' },
    { ...playing, mode: 'result', resultAction: 1 },
    { mode: 'sensor-error' },
  ];
  for (const screen of screens) {
    const capture = nativeContext();
    renderSpatial(capture.ctx, screen);
    assert.deepEqual(capture.rectFills.filter(({ bounds }) => bounds[2] >= 480 && bounds[3] >= 352), [
      { bounds: [0, 0, 480, 352], color: '#000000', alpha: 1 },
    ], screen.mode);
    assert.equal(capture.metrics().gradientCount, 0, screen.mode);
    assert.ok(capture.rectFills.every(({ color, bounds }) => color === '#000000' || bounds[2] < 60 || bounds[3] < 24), screen.mode);
    assert.ok(capture.pathFills.every(({ color, width, height }) => color === '#000000' || width < 60 || height < 24), screen.mode);
  }
});

test('real-time frame meter appears in view without covering the stage', () => {
  const perf = { text: '帧率 24 · 间隔 41.6ms · 峰值 88ms · 绘制 3.2ms', fps: 24, intervalMs: 41.6, peakMs: 88 };
  const playing = model();
  const capture = nativeContext();
  renderSpatial(capture.ctx, { ...playing, perf });
  const paint = capture.textPaints.find(item => item.value === '24 FPS · 峰值 88ms');
  assert.ok(paint, 'frame meter text is drawn');
  assert.equal(paint.color, GLASSES_INK.text, 'a slow frame highlights the meter');
  assert.ok(paint.x > 440 && paint.y > 315, 'compact meter sits in the bottom corner');
  assert.deepEqual(capture.rectFills.map(item => item.bounds), [[0, 0, 480, 352]], 'no HUD backing can erase approaching arrows');
  const paused = nativeContext();
  renderSpatial(paused.ctx, { ...playing, mode: 'paused', perf });
  assert.ok(paused.texts.includes(perf.text), 'the paused screen keeps the last window readable');

  const clean = nativeContext();
  renderSpatial(clean.ctx, playing);
  assert.equal(clean.texts.some(value => value.includes('FPS')), false);
});

test('leaderboard screen lists the song board and marks the player', () => {
  const board = {
    status: 'ready', songTitle: 'Party Sector · 完整', totalPlayers: 5,
    entries: [
      { position: 1, is_me: 0, display_name: '阿青', score: 72000 },
      { position: 2, is_me: 0, display_name: '小林', score: 65000 },
      { position: 3, is_me: 0, display_name: '测试玩家名字很长', score: 60000 },
      { position: 4, is_me: 1, display_name: '我', score: 55000 },
    ],
    me: { position: 4, score: 55000 },
  };
  const capture = nativeContext();
  renderSpatial(capture.ctx, { mode: 'leaderboard', leaderboard: board });
  for (const value of ['排行榜', 'Party Sector · 完整', '全时段 · 本曲', '5 人', '阿青', '72000', '你', '单击返回']) {
    assert.ok(capture.texts.includes(value), value);
  }
  const me = capture.textPaints.find(item => item.value === '我' && item.color === GLASSES_INK.bright);
  assert.ok(me, 'the current player is highlighted');
  assert.deepEqual(capture.metrics(), { gradientCount: 0, flushCount: 1, saveDepth: 0 });
  assert.ok(capture.calls.length < 300);

  const loading = nativeContext();
  renderSpatial(loading.ctx, { mode: 'leaderboard', leaderboard: { status: 'loading', songTitle: 'Party Sector · 完整' } });
  assert.ok(loading.texts.includes('正在读取排行榜…'));
  const failed = nativeContext();
  renderSpatial(failed.ctx, { mode: 'leaderboard', leaderboard: { status: 'error', message: '排行榜未配置' } });
  assert.ok(failed.texts.includes('排行榜未配置'));
});

test('leaderboard tabs highlight the viewed song and leave room for eight ranks plus the personal rank', () => {
  const songs = getCourses().filter(course => course.native);
  const entries = Array.from({ length: 8 }, (_, index) => ({
    position: index + 1, is_me: 0, display_name: `玩家${index + 1}`, score: 10000 - index * 1000,
  }));
  for (const selected of songs) {
    const capture = nativeContext();
    renderSpatial(capture.ctx, { mode: 'leaderboard', leaderboard: {
      status: 'ready', songs, songId: selected.id, entries, me: { position: 18, score: 1000 },
    } });
    const tabs = capture.textPaints.filter(item => item.y === 63);
    assert.deepEqual(tabs.map(tab => tab.value), songs.map(song => song.title));
    assert.deepEqual(tabs.filter(tab => tab.color === GLASSES_INK.bright).map(tab => tab.value), [selected.title]);
    assert.ok(capture.textPaints.some(item => item.value === selected.title && item.y === 98));
    assert.deepEqual(capture.textPaints.filter(item => /^玩家\d$/.test(item.value)).map(item => item.value), entries.map(entry => entry.display_name));
    assert.ok(capture.textPaints.find(item => item.value === '玩家8').y < 310);
    assert.ok(capture.textPaints.find(item => item.value === '你 · 第 18 名 · 1000').y < 335);
    assert.ok(capture.texts.includes('滑动切换曲目 · 单击返回'));
  }
});
