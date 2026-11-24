import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Session } from '../src/lib/session.js';
import { ResearchLog } from '../src/lib/research-log.js';
import { LanResearchLog } from '../src/lib/lan-research-log.js';
import { ConsoleResearchLog } from '../src/lib/console-research-log.js';
import { HeadPose } from '../src/lib/head-pose.js';
import { createPerfMeter } from '../src/lib/perf-meter.js';
import { MenuNavigation, templeKey } from '../src/lib/menu-navigation.js';
import { tutorialSample, warmupSample } from './fixtures/motion.js';

const source = await readFile(new URL('../src/pages/index/index.ink', import.meta.url), 'utf8');
const code = source.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*;$/gm, '').replace('export default', 'globalThis.page =');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

const TUTORIAL_KEY = 'rhythm-tutorial-complete-v1';

function setup({logURL, request, rejectResearchStorage=false, tutorialComplete=true, animationFrames=false, motionDiagnostics=false}={}) {
  let now = 0, nextTimer = 1, canvasCreates = 0;
  const active = new Map(), errors = [], sensors = [], storage = new Map(), rendered = [], consoleLines = [], previews = [];
  if (tutorialComplete) storage.set(TUTORIAL_KEY, true);
  class TestAudio {
    now() { return now; }
    async prepare() {}
    async suspend() {}
    async close() {}
    setCourse() {}
    startPreview(course) { previews.push(course.id); this.preview = course; }
    stopPreview() { this.preview = null; }
    previewState() { return { playing: !!this.preview, progress: 0 }; }
    countdown() {}
    tick() {}
    feedback() {}
  }
  class TutorialVoice {
    retries = 0;
    stops = 0;
    retry() { this.retries++; }
    stop() { this.stops++; }
  }
  class Sensor {
    constructor() { this.listeners = new Map(); this.started = false; this.stops = 0; sensors.push(this); }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    start() { this.started = true; }
    stop() { this.started = false; this.stops++; }
    fail() { for (const callback of this.listeners.get('error') || []) callback({message:'sensor unavailable'}); }
    emit(reading = { x: 0, y: 0, z: 9.81 }) {
      Object.assign(this, reading);
      for (const callback of this.listeners.get('reading') || []) callback();
    }
  }
  class Accelerometer extends Sensor {
    emit(reading = { x: 0, y: 0, z: 9.81 }) {
      // Scripted motion fixtures use +Z up; the glasses use device +Y up.
      super.emit({ ...reading, y: reading.z, z: -reading.y });
    }
  }
  class Gyroscope extends Sensor {}
  class AbsoluteOrientationSensor extends Sensor {
    constructor() { super(); this.quaternion = null; }
    emitQuat(quaternion) {
      this.quaternion = quaternion;
      for (const callback of this.listeners.get('reading') || []) callback();
    }
  }
  function clearTimer(id) {
    if (!Number.isInteger(id)) throw new TypeError('native timer requires i32');
    active.delete(id);
  }
  const sandbox = {
    Session, ResearchLog, LanResearchLog, ConsoleResearchLog, HeadPose, createPerfMeter, MenuNavigation, templeKey, TutorialVoice,
    RhythmAudio: TestAudio, AudioContext: undefined, AudioPlayer: undefined, Accelerometer, Gyroscope, AbsoluteOrientationSensor,
    render: (_ctx, model) => rendered.push(model), SERVICE_CONFIG: {logURL, motionDiagnostics}, performance: { now: () => now },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    wx: {
      createCanvasContext: () => { canvasCreates++; return {}; },
      request,
      getStorageSync: key => {
        if (rejectResearchStorage && key === 'rhythm-research-index-v1') throw new Error('lock_shared() not supported');
        return storage.get(key);
      },
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
    },
    console: { error: (...args) => errors.push(args.join(' ')), warn: () => {}, log: line => consoleLines.push(line) },
    setTimeout: fn => { const id = nextTimer++; active.set(id, { fn, once: true }); return id; },
    setInterval: fn => { const id = nextTimer++; active.set(id, { fn }); return id; },
    clearTimeout: clearTimer, clearInterval: clearTimer,
  };
  if (animationFrames) {
    sandbox.requestAnimationFrame = fn => {
      const id = nextTimer++;
      active.set(id, { fn, animation: true });
      return id;
    };
    sandbox.cancelAnimationFrame = clearTimer;
  }
  vm.runInNewContext(code, sandbox);
  const page = sandbox.page; page.onLoad();
  return {
    page, active, errors, sensors, Accelerometer, Gyroscope, AbsoluteOrientationSensor, rendered, storage, consoleLines, previews,
    get canvasCreates() { return canvasCreates; },
    time: value => { now = value; },
    advance: delta => { now += delta; },
    flushTimeouts() {
      for (const [id, item] of [...active]) if (item.once) { active.delete(id); item.fn(); }
    },
    frame() {
      for (const [id, item] of [...active]) if (!item.once) {
        if (item.animation) active.delete(id);
        item.fn();
      }
    },
    accel: () => sensors.findLast(sensor => sensor instanceof Accelerometer),
  };
}

async function resultPage() {
  const fixture = setup(), { page } = fixture;
  await page._session.start('keyboard');
  for (let now = 0; now <= 12000 && page._session.mode !== 'playing'; now += 50) {
    fixture.time(now); page._session.tick();
  }
  assert.equal(page._session.mode, 'playing');
  fixture.time(page._session.game.origin + page._session.courses[0].durationMs);
  page._session.tick();
  assert.equal(page._session.mode, 'result');
  return fixture;
}
async function playingPage(options) {
  const fixture = setup(options), { page } = fixture;
  page.onReady(); fixture.flushTimeouts();
  await page._confirm();
  const orientation = fixture.sensors.find(sensor => sensor instanceof fixture.AbsoluteOrientationSensor);
  let now = 0;
  while (page._session.mode !== 'playing' && now <= 12000) {
    fixture.time(now);
    const { accel, quaternion } = warmupSample(page._session, now);
    if (orientation) orientation.emitQuat(quaternion);
    fixture.accel().emit(accel);
    fixture.frame();
    now += 20;
  }
  assert.equal(page._session.mode, 'playing');
  fixture.time(now);
  return fixture;
}

test('AIUI initial open, repeated show/hide, and unload never clear an absent native timer', () => {
  const fixture = setup(), { page, active, errors } = fixture;
  page.onReady(); fixture.flushTimeouts();
  assert.deepEqual(errors, []);
  assert.equal(active.size, 1); page.onShow(); assert.equal(active.size, 1);
  page.onHide(); assert.equal(active.size, 0); page.onHide();
  page.onShow(); assert.equal(active.size, 1); page.onUnload(); assert.equal(active.size, 0);
});

test('display callbacks cap frame submissions and a silent host falls back to a timer', () => {
  const fixture = setup({ animationFrames: true });
  const { page, active } = fixture;
  let draws = 0;
  page._frame = () => { draws++; };
  page.onReady(); fixture.flushTimeouts();
  assert.equal(draws, 1);
  fixture.time(17); fixture.frame();
  assert.equal(draws, 1);
  fixture.time(34); fixture.frame();
  assert.equal(draws, 2);
  fixture.time(51); fixture.frame();
  assert.equal(draws, 2);
  page.onHide();
  assert.equal(active.size, 0);

  page.onShow();
  fixture.advance(400); fixture.flushTimeouts();
  assert.equal(draws, 4, 'timeout draws without waiting for the first display callback');
  assert.equal([...active.values()].some(timer => timer.animation), false);
  fixture.advance(34); fixture.frame();
  assert.equal(draws, 5);
  page.onUnload();
  assert.equal(active.size, 0);
});

test('hiding before deferred canvas initialization still initializes exactly once on show', () => {
  const fixture = setup(), { page, active } = fixture;
  page.onReady(); page.onHide(); fixture.flushTimeouts();
  assert.equal(fixture.canvasCreates, 0);
  assert.equal(active.size, 0);
  page.onShow(); fixture.flushTimeouts();
  assert.equal(fixture.canvasCreates, 1);
  assert.equal(active.size, 1);
  page.onShow(); fixture.flushTimeouts();
  assert.equal(fixture.canvasCreates, 1);
  assert.equal(active.size, 1);
  page.onUnload(); assert.equal(active.size, 0);
});

test('static screens draw once, then redraw when course focus or the saved result changes', async () => {
  const fixture = await resultPage(), { page, rendered } = fixture;
  page.onReady(); fixture.flushTimeouts(); fixture.frame(); fixture.frame();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].mode, 'result');
  page.onKeyUp({ key: 'ArrowDown' }); fixture.frame();
  assert.equal(rendered.at(-1).resultAction, 1);
  page._session.saved = '成绩已同步'; fixture.frame(); fixture.frame();
  assert.equal(rendered.length, 3);
  assert.equal(rendered.at(-1).saved, '成绩已同步');
  page.onKeyUp({ key: 'Escape' }); fixture.frame();
  assert.equal(rendered.at(-1).mode, 'home');
  fixture.advance(300);
  page.onKeyUp({ key: 'ArrowDown' }); fixture.frame(); fixture.frame();
  assert.equal(rendered.length, 5);
  assert.equal(rendered.at(-1).menu.songIndex, 1);
  page.onUnload();
});

test('playing frames reuse the tick snapshot and retain a timing gap when pausing', async () => {
  const fixture = await playingPage({ motionDiagnostics: true }), { page, rendered } = fixture;
  rendered.length = 0;
  const game = page._session.game;
  const snapshot = game.snapshot.bind(game);
  let snapshots = 0;
  game.snapshot = now => { snapshots++; return snapshot(now); };
  const records = [];
  const append = page._research.append.bind(page._research);
  page._research.append = event => { records.push(event); return append(event); };
  const origin = page._session.game.origin;
  fixture.time(origin + 100); fixture.accel().emit(); fixture.frame();
  fixture.time(origin + 200); fixture.accel().emit(); fixture.frame();
  assert.ok(rendered.length >= 2, 'both frames were drawn');
  assert.ok(snapshots >= 2);
  assert.equal(rendered.at(-1).state.elapsedMs, 200);
  await page._confirm();
  const timing = records.find(event => event.type === 'frame-timing');
  assert.ok(timing.frames >= 2);
  assert.ok(timing.maxGapMs >= 100);
  page.onUnload();
});

test('diagnostic build limits raw logging without skipping motion samples', async () => {
  const fixture = await playingPage({ motionDiagnostics: true }), { page } = fixture;
  const samples = [];
  page._session.onTrace = event => { if (event.type === 'imu') samples.push(event.clockMs); };
  const start = page._session.game.origin + 300;
  for (let offset = 0; offset <= 100; offset += 20) {
    fixture.time(start + offset);
    fixture.accel().emit();
    assert.equal(page._session.lastSample, start + offset);
  }
  assert.deepEqual(samples, [start, start + 80]);
  page.onUnload();
});

test('release build plays without motion logging, upload or frame diagnostics', async () => {
  const requests = [];
  const fixture = await playingPage({logURL:'http://127.0.0.1:8787/log', request: options => requests.push(options)});
  const { page, rendered, storage, consoleLines } = fixture;
  const at = page._session.game.origin + 100;
  fixture.time(at); fixture.accel().emit(); fixture.frame();
  assert.equal(page._session.lastSample, at);
  assert.equal(rendered.at(-1).mode, 'playing');
  assert.equal(rendered.at(-1).showMotionDebug, false);
  assert.equal(rendered.at(-1).perf, null);
  assert.equal(page._research, null);
  assert.equal(page._usbLog, null);
  assert.equal(page._lanLog, null);
  assert.equal(page._session._traceOpen, false);
  page.onUnload();
  assert.equal([...storage.keys()].some(key => key.startsWith('rhythm-research')), false);
  assert.equal(consoleLines.some(line => line.startsWith('[rhythm-live] ')), false);
  assert.deepEqual(requests, []);
});

test('the game page uploads during a run and retains calibration and samples across frame timing and storage failure', async () => {
  const requests = [];
  const fixture = setup({
    motionDiagnostics: true,
    logURL: 'http://127.0.0.1:8787/log',
    rejectResearchStorage: true,
    request(options) { requests.push(options); },
  });
  const {page} = fixture;
  page.onReady(); fixture.flushTimeouts();
  await page._confirm(); await settle();
  assert.equal(requests.length, 1, 'the start and chart are sent immediately');
  const first = JSON.parse(requests[0].data);
  assert.equal(first.chunk, 0);
  assert.equal(first.final, false);
  assert.equal(first.rows[0].type, 'start');
  assert.ok(first.rows.some(row => row.type === 'chart'));
  fixture.time(100); fixture.accel().emit();
  // The timing window used to erase all the memory-backed trace rows.
  page._recordFrameTiming(100, 101, 102);
  page._flushFrameTiming();
  requests[0].fail({errMsg:'network disconnected'}); await settle();
  fixture.time(4099); fixture.frame(); await settle();
  assert.equal(requests.length, 1);
  fixture.time(4100); fixture.frame(); await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].data, requests[0].data, 'retry sends the same batch');
  requests[1].success({statusCode:200,data:{ok:true,exportId:first.exportId,chunk:0}}); await settle();
  const live = JSON.parse(requests[2].data);
  assert.equal(live.chunk, 1);
  assert.equal(live.final, false);
  assert.ok(live.rows.some(row => row.type === 'imu'));
  assert.ok(live.rows.some(row => row.type === 'frame-timing'));
  requests[2].success({statusCode:200,data:{ok:true,exportId:first.exportId,chunk:1}}); await settle();
  page._session.home(); await settle();
  const last = JSON.parse(requests.at(-1).data);
  assert.equal(last.exportId, first.exportId);
  assert.equal(last.chunk, 2);
  assert.equal(last.final, true);
  assert.equal(last.rows.at(-1).type, 'end');
  const usbPackets = fixture.consoleLines.filter(line => line.startsWith('[rhythm-live] '))
    .map(line => JSON.parse(line.slice('[rhythm-live] '.length)));
  assert.ok(usbPackets.length > 1 && usbPackets.every(packet => packet.exportId === 'usb-' + first.exportId));
  const usbRows = usbPackets.flatMap(packet => packet.rows);
  assert.equal(usbRows[0].type, 'start');
  assert.ok(usbRows.some(row => row.type === 'imu'));
  assert.equal(usbRows.at(-1).type, 'end');
  assert.equal(usbPackets.at(-1).final, true);
  requests.at(-1).success({statusCode:200,data:{ok:true,exportId:first.exportId,chunk:2}}); await settle();
  page.onUnload();
});

test('result swipes and confirm route replay, leaderboard and main menu', async () => {
  for (const route of ['replay', 'leaderboard', 'home']) {
    const fixture = await resultPage(), { page } = fixture;
    const previousGame = page._session.game;
    let prevented = 0;
    const key = value => page.onKeyUp({ detail: { key: value }, preventDefault() { prevented++; } });
    if (route === 'leaderboard') key('ArrowRight');
    if (route === 'home') key('ArrowUp');
    assert.equal(page._resultAction, { replay: 0, leaderboard: 1, home: 2 }[route]);
    key('Enter'); await settle();
    assert.ok(prevented >= 1);
    if (route === 'home') {
      assert.equal(page._session.mode, 'home');
      assert.equal(page._menu.focus, 'song');
      assert.equal(fixture.sensors.length, 0);
    } else if (route === 'leaderboard') {
      assert.equal(page._session.mode, 'leaderboard');
      assert.equal(page._leaderboard.status, 'error');
      assert.equal(page._leaderboard.message, '排行榜未配置');
      fixture.advance(300);
      page.handleTap();
      assert.equal(page._session.mode, 'result', 'closing the board returns to the result');
    } else {
      assert.equal(page._session.mode, 'calibrating', route);
      assert.equal(page._session.source, 'imu');
      assert.equal(page._session.game.course.id, 'beatucada');
      assert.notEqual(page._session.game, previousGame);
      assert.equal(page._session.model().state.score, 0);
      assert.equal(page._resultAction, 0);
      assert.equal(fixture.sensors.filter(sensor => sensor.started).length, 2);
    }
    page.onUnload();
    assert.ok(fixture.sensors.every(sensor => !sensor.started && [...sensor.listeners.values()].every(listeners => listeners.size === 0)));
    assert.deepEqual(fixture.errors, []);
  }
});

test('the tutorial menu entry waits for preparation confirmation before calibrating', async () => {
  const fixture = setup(), { page } = fixture;
  page.onReady(); fixture.flushTimeouts();
  page.onKeyUp({ key: 'ArrowUp' });
  assert.equal(page._menu.focus, 'tutorial');
  page.onKeyUp({ key: 'Enter' });
  await settle();
  assert.equal(page._session.mode, 'tutorial-ready');
  assert.ok(fixture.sensors.every(sensor => !sensor.started));
  fixture.advance(300);
  page.onKeyUp({ key: 'Enter' }); await settle();
  assert.equal(page._session.mode, 'calibrating');
  assert.equal(page._session.game.course.id, 'tutorial');
  page.onUnload();
  assert.deepEqual(fixture.errors, []);
});

test('temple swipe bursts move just one row and selecting a song switches its preview', async () => {
  const fixture = setup(), { page, previews } = fixture;
  page.onReady(); fixture.flushTimeouts();
  assert.deepEqual(previews, ['beatucada']);
  page.onKeyDown({ code: 'ArrowDown' });
  page.onKeyUp({ code: 'ArrowDown' });
  fixture.time(55);
  page.onKeyUp({ detail: { key: 'Right' }, repeat: true });
  fixture.time(90);
  page.onKeyUp({ key: 'Down' });
  page.handleSurfaceTap();
  fixture.frame();
  assert.equal(page._session.mode, 'home');
  assert.deepEqual(previews, ['beatucada', 'into-my-dream']);
  fixture.time(400);
  page.onKeyUp({ code: 'ArrowDown' }); fixture.frame();
  assert.deepEqual(previews, ['beatucada', 'into-my-dream', 'summer-overload']);
  page.onKeyUp({ key: 'Enter' }); await settle();
  assert.equal(page._session.game.course.id, 'summer-overload');
  assert.equal(page._audio.preview, null);
  page.onUnload();
});

test('result Backspace cancels the host default before returning to the menu', async () => {
  const fixture = await resultPage(), { page } = fixture;
  const dispatch = (handler, code = 'Backspace') => {
    let prevented = false;
    let stopped = false;
    page[handler]({
      code,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });
    return { prevented, stopped };
  };
  assert.deepEqual(dispatch('onKeyDown'), { prevented: false, stopped: false });
  assert.deepEqual(dispatch('onKeyUp'), { prevented: true, stopped: true });
  assert.equal(page._session.mode, 'home');
  assert.deepEqual(dispatch('onKeyUp'), { prevented: false, stopped: false },
    'a fresh Back at the main menu is handled by the host');
  page.onUnload();
});

test('one Back gesture only pauses gameplay, then a fresh Back returns to the menu', async () => {
  const fixture = await playingPage(), { page } = fixture;
  const back = () => page.onKeyUp({ code: 'Backspace', preventDefault() {} });
  back();
  assert.equal(page._session.mode, 'paused');
  back();
  assert.equal(page._session.mode, 'home');
  page.onUnload();
});

test('head aim and dwell open the selected song leaderboard and suspend menu audio', async () => {
  const fixture = setup(), { page, rendered } = fixture;
  page.onReady(); fixture.flushTimeouts();
  const requests = [];
  page._leaderboardClient = { fetchLeaderboard: async params => { requests.push(params); return {}; } };
  page._menuHead.pose = () => ({ valid: true, yaw: 0.21, pitch: 0.1, ageMs: 40 });
  fixture.time(40); fixture.frame();
  fixture.time(3040); fixture.frame();
  assert.equal(page._session.mode, 'home', 'a delayed frame cannot confirm a target');
  for (let now = 3140; now < 6040; now += 100) { fixture.time(now); fixture.frame(); }
  assert.equal(rendered.at(-1).menu.focus, 'leaderboard');
  assert.equal(page._audio.preview, null);
  fixture.time(6040); fixture.frame(); await settle();
  assert.equal(page._session.mode, 'leaderboard');
  assert.deepEqual(requests.map(request => request.songId), ['beatucada']);
  page.onUnload();
});

test('the menu stays operable after pose loss and a failed calibration sensor can be restarted', async () => {
  const fixture = setup(), { page, AbsoluteOrientationSensor, sensors } = fixture;
  page.onReady(); fixture.flushTimeouts();
  const orientation = sensors.find(sensor => sensor instanceof AbsoluteOrientationSensor);
  orientation.fail();
  assert.equal(orientation.started, false);
  page.onKeyUp({ code: 'ArrowDown' }); fixture.frame();
  await page._confirm();
  assert.equal(page._session.mode, 'calibrating');
  assert.equal(page._session.game.course.id, 'into-my-dream');
  const accel = fixture.accel();
  accel.fail();
  assert.equal(accel.started, false);
  assert.equal(page._session.mode, 'sensor-error');
  await page._confirm();
  assert.equal(page._session.mode, 'calibrating');
  assert.notEqual(fixture.accel(), accel);
  page.onUnload();
});

test('hiding during start preparation cancels the start and cannot attach sensors after show', async () => {
  const fixture = setup(), { page } = fixture, preparing = deferred();
  page._audio.prepare = () => preparing.promise;
  const confirming = page._confirm();
  page.onHide(); page.onShow();
  preparing.resolve(); await confirming;
  assert.equal(page._session.mode, 'home');
  assert.equal(fixture.sensors.length, 0);
  assert.equal(page._confirming, false);
});

test('one tap resumes an IMU session only after a fresh valid sensor reading', async () => {
  const fixture = await playingPage(), { page } = fixture;
  const pausedAt = page._session.model().state.elapsedMs;
  await page._confirm();
  assert.equal(page._session.mode, 'paused');
  const previousSensors = [...fixture.sensors];
  fixture.time(5000); await page._confirm();
  assert.equal(page._session.mode, 'paused');
  assert.equal(page._resumePending, true);
  assert.equal(page._session.lastSample, null);
  assert.ok(previousSensors.every(sensor => !sensor.started));
  const accel = fixture.accel();
  accel.emit({ x: NaN, y: 0, z: 9.81 }); await settle();
  assert.equal(page._session.mode, 'paused', 'an invalid sample is not a fresh signal');
  accel.emit(); await settle();
  assert.equal(page._session.mode, 'playing');
  assert.equal(page._resumePending, false);
  assert.equal(page._session.model().state.elapsedMs, pausedAt, 'resuming preserves the original beat');
  assert.equal(page._session.model().state.score, 0, 'controls and stationary sensor readings never score');
  page.onUnload();
  assert.ok(fixture.sensors.every(sensor => !sensor.started));
});

test('hide and show during resume preparation cannot revive an earlier resume request', async () => {
  const fixture = await playingPage(), { page } = fixture;
  await page._confirm();
  const preparing = deferred(), beforeSensors = fixture.sensors.length;
  page._audio.prepare = () => preparing.promise;
  const confirming = page._confirm();
  page.onHide(); page.onShow();
  preparing.resolve(); await confirming;
  assert.equal(page._session.mode, 'paused');
  assert.equal(page._resumePending, false);
  assert.equal(fixture.sensors.length, beforeSensors, 'a request from before hide cannot attach new sensors');
});

test('hiding while fresh-signal audio preparation is pending cannot resume a hidden game', async () => {
  const fixture = await playingPage(), { page } = fixture;
  await page._confirm();
  const preparing = deferred(); let preparations = 0;
  page._audio.prepare = () => ++preparations === 1 ? Promise.resolve() : preparing.promise;
  await page._confirm();
  fixture.accel().emit();
  assert.equal(preparations, 2);
  page.onHide();
  preparing.resolve(); await settle();
  assert.equal(page._session.mode, 'paused');
  assert.equal(page._resumePending, false);
  assert.ok(fixture.sensors.every(sensor => !sensor.started));
});

test('the page calibrates sideways movement from fresh orientation and drops stale lateral input', async () => {
  const fixture = setup({ motionDiagnostics: true }), { page, rendered } = fixture;
  page.onReady(); fixture.flushTimeouts();
  await page._confirm();
  assert.equal(page._session.mode, 'calibrating');
  const orientation = fixture.sensors.find(sensor => sensor instanceof fixture.AbsoluteOrientationSensor);
  assert.ok(orientation && orientation.started, 'absolute orientation starts with the motion sensors');

  let now = 0;
  while (page._session.mode !== 'playing' && now <= 20000) {
    fixture.time(now);
    const { accel, quaternion } = warmupSample(page._session, now);
    orientation.emitQuat(quaternion);
    fixture.accel().emit(accel);
    fixture.frame();
    now += 20;
  }
  assert.equal(page._session.mode, 'playing');
  assert.ok(page._research.active, 'neutral calibration starts a research capture');
  assert.equal(page._head.calibrated, true, 'forward is captured from the upright pose');

  const playingAt = now;
  const turn = [0, -Math.sin(0.2), 0, Math.cos(0.2)];
  fixture.time(playingAt + 100); orientation.emitQuat(turn); fixture.accel().emit(); fixture.frame();
  const posed = rendered.at(-1);
  assert.equal(posed.poseSupported, true);
  assert.equal(posed.pose.valid, true);
  assert.ok(Math.abs(posed.pose.yaw) > 0.15, 'a rightward turn reaches the renderer as positive yaw');

  for (let at = playingAt + 120; at <= playingAt + 900; at += 20) {
    fixture.time(at); fixture.accel().emit(); fixture.frame();
  }
  const stale = rendered.at(-1);
  assert.equal(page._session.mode, 'playing', 'a quiet orientation sensor does not interrupt the chart');
  assert.equal(stale.body.sideReady, false, 'old orientation cannot drive the lateral detector');
  assert.equal(stale.pose.valid, false);
  assert.equal(stale.pose.stale, true);
});

test('first launch waits without sampling and a song can calibrate independently after skipping the tutorial', async () => {
  const fixture = setup({ tutorialComplete: false }), { page } = fixture;
  page.onReady(); fixture.flushTimeouts(); await settle();
  assert.equal(page._session.mode, 'tutorial-ready');
  assert.equal(page._session.game, undefined);
  assert.equal(fixture.rendered.some(model => model.mode === 'home'), false);

  fixture.time(5000); fixture.frame();
  assert.equal(page._session.mode, 'tutorial-ready');
  assert.equal(fixture.sensors.length, 0);
  assert.equal(page._session.baseQuaternion, null);
  page.handleTap(); await settle();
  assert.equal(page._session.game.course.id, 'tutorial');
  fixture.time(5002); page.onKeyUp({ key: 'Enter' });
  assert.equal(page._session.mode, 'calibrating', 'duplicate events from one tap are ignored');
  fixture.time(5170); page.handleTap();
  fixture.time(5340); page.handleTap(); fixture.frame();
  assert.equal(page._session.mode, 'home');
  assert.equal(fixture.storage.get(TUTORIAL_KEY), undefined);
  assert.deepEqual(Array.from(fixture.rendered.at(-1).courses, course => course.id), ['beatucada','into-my-dream','summer-overload']);

  fixture.time(5510);
  page.handleTap(); await settle();
  assert.equal(page._session.mode, 'calibrating');
  assert.equal(page._session.model().stand.step, 'capture');
  assert.equal(page._session.game.course.id, 'beatucada');
  assert.equal(page._session.tutorial, null);
  assert.equal(fixture.storage.get(TUTORIAL_KEY), undefined);
  page.onUnload();
});

test('the tutorial records completion separately and selecting a song checks fresh IMU before reuse', async () => {
  const fixture = setup({ tutorialComplete: false }), { page } = fixture;
  page.onReady(); fixture.flushTimeouts(); await settle();
  page.handleTap(); await settle();
  assert.equal(page._session.game.course.id, 'tutorial');
  assert.equal(page._session.model().stand.step, 'capture');
  assert.equal(page._session.body.options.enableLateralFlight, true);
  const orientation = fixture.sensors.findLast(sensor => sensor instanceof fixture.AbsoluteOrientationSensor);
  let now = 0;
  for (; now <= 18000 && page._session.mode !== 'home'; now += 20) {
    fixture.time(now);
    const { accel, quaternion } = tutorialSample(page._session, now);
    orientation.emitQuat(quaternion); fixture.accel().emit(accel); fixture.frame();
  }
  assert.equal(page._session.mode, 'home');
  assert.equal(fixture.storage.get(TUTORIAL_KEY), true);
  assert.ok(fixture.rendered.some(model => model.tutorial?.completed));
  assert.equal(page._tutorialVoice.retries, 2);
  assert.ok(page._tutorialVoice.stops > 0);

  const baseline = page._session.baseQuaternion;
  page.handleTap(); await settle();
  assert.equal(page._session.mode, 'calibrating');
  assert.equal(page._session.model().stand.step, 'checking');
  assert.equal(page._session.game.course.id, 'beatucada');
  assert.equal(page._session.body.options.enableLateralFlight, false);
  fixture.time(now + 200); fixture.frame();
  assert.equal(page._session.mode, 'calibrating', 'elapsed time without fresh sensor readings cannot approve reuse');
  const freshOrientation = fixture.sensors.findLast(sensor => sensor instanceof fixture.AbsoluteOrientationSensor);
  for (let at = now + 220; at <= now + 440 && page._session.mode !== 'playing'; at += 20) {
    fixture.time(at);
    freshOrientation.emitQuat(warmupSample().quaternion); fixture.accel().emit(); fixture.frame();
  }
  assert.equal(page._session.mode, 'playing');
  assert.equal(page._session.baseQuaternion, baseline);
  page.onUnload();
  assert.deepEqual(fixture.errors, []);

  const reopened = setup({ tutorialComplete: fixture.storage.get(TUTORIAL_KEY) });
  reopened.page.onReady(); reopened.flushTimeouts(); await settle();
  assert.equal(reopened.page._session.mode, 'home');
  assert.equal(reopened.sensors.length, 1, 'only the orientation sensor is needed on the menu');
  reopened.page.onUnload();
});

test('replay revalidates its position after normal sensor shutdown at the result', async () => {
  const fixture = await playingPage(), { page, sensors, AbsoluteOrientationSensor } = fixture;
  const session = page._session;
  const baseline = session.baseQuaternion;
  const priorAccel = fixture.accel();
  session.game.origin -= session.game.course.durationMs;
  fixture.frame();
  assert.equal(session.mode, 'result');
  assert.equal(priorAccel.started, false);

  await page._confirm();
  assert.equal(session.model().stand.step, 'checking');
  assert.notEqual(fixture.accel(), priorAccel);
  const orientation = sensors.findLast(sensor => sensor instanceof AbsoluteOrientationSensor);
  for (let i = 0; i < 10; i++) {
    fixture.advance(20); fixture.accel().emit(); fixture.frame();
  }
  assert.equal(session.mode, 'calibrating', 'new acceleration cannot reuse an old orientation');
  for (let i = 0; i < 12 && session.mode !== 'playing'; i++) {
    fixture.advance(20); orientation.emitQuat(warmupSample().quaternion); fixture.accel().emit(); fixture.frame();
  }
  assert.equal(session.mode, 'playing');
  assert.equal(session.baseQuaternion, baseline);
  page.onUnload();
});



test('opening the leaderboard fetches the current song and reuses the cache', async () => {
  const fixture = await resultPage(), { page, rendered } = fixture;
  const calls = [];
  page._leaderboardClient = {
    fetchLeaderboard: async params => {
      calls.push(params);
      return {
        song_id: params.songId, song_title: 'Beatucada', chart_version: params.chartVersion,
        entries: [{ position: 1, is_me: 1, display_name: '小林', score: 65000 }],
        me: { position: 1, score: 65000 }, total_players: 1,
      };
    },
  };
  page.onReady(); fixture.flushTimeouts();
  page._resultAction = 1;
  await page._confirm(); await settle();
  assert.equal(page._session.mode, 'leaderboard');
  assert.equal(calls[0].songId, 'beatucada');
  assert.equal(calls[0].chartVersion, 1);
  assert.equal(calls[0].limit, 8);
  assert.equal(page._leaderboard.status, 'ready');
  fixture.frame();
  assert.equal(rendered.at(-1).mode, 'leaderboard');
  assert.equal(rendered.at(-1).leaderboard.entries[0].score, 65000);

  page.handleTap();
  assert.equal(page._session.mode, 'result', 'closing returns to the result it came from');
  page._resultAction = 1;
  await page._confirm(); await settle();
  assert.equal(calls.length, 1, 'a fresh board is served from the 60 s cache');
  page.onUnload();
  assert.deepEqual(fixture.errors, []);
});

test('the main-menu leaderboard switches through all songs and ignores out-of-order replies', async () => {
  const fixture = setup(), { page, rendered } = fixture;
  const requested = new Map();
  page._leaderboardClient = {
    fetchLeaderboard({ songId }) {
      const pending = deferred();
      requested.set(songId, pending);
      return pending.promise;
    },
  };
  page.onReady(); fixture.flushTimeouts();
  page._menu.focusOn(page._menu.targets.find(target => target.focus === 'leaderboard'));
  await page._confirm();
  assert.equal(page._session.mode, 'leaderboard');
  assert.equal(page._leaderboard.songId, 'beatucada');
  page.onKeyUp({ key: 'ArrowDown' });
  assert.equal(page._leaderboard.songId, 'into-my-dream');
  fixture.advance(300);
  page.onKeyUp({ key: 'ArrowDown' });
  assert.equal(page._leaderboard.songId, 'summer-overload');
  requested.get('summer-overload').resolve({ entries: [{ score: 3000 }] });
  requested.get('beatucada').resolve({ entries: [{ score: 1000 }] });
  requested.get('into-my-dream').resolve({ entries: [{ score: 2000 }] });
  await settle(); fixture.frame();
  assert.equal(rendered.at(-1).leaderboard.entries[0].score, 3000);
  assert.deepEqual(Array.from(rendered.at(-1).leaderboard.songs, song => song.id), ['beatucada','into-my-dream','summer-overload']);
  page.handleTap();
  assert.equal(page._session.mode, 'home');
  page.onUnload();
});

test('finishing submits one score and puts the rank on the result screen', async () => {
  const fixture = setup(), { page } = fixture;
  const submitted = [];
  page._leaderboardClient = {
    submitScore: async payload => {
      submitted.push(payload);
      return {
        song_id: payload.songId, song_title: 'Beatucada', chart_version: payload.chartVersion,
        entries: [], me: { position: 2, score: payload.score }, total_players: 2,
        submitted: { position: 2, score: payload.score, is_best: 1 },
      };
    },
  };
  await page._session.start('keyboard');
  for (let now = 0; now <= 12000 && page._session.mode !== 'playing'; now += 50) {
    fixture.time(now); page._session.tick();
  }
  assert.equal(page._session.mode, 'playing');
  fixture.time(page._session.game.origin + page._session.courses[0].durationMs);
  page._session.tick();
  assert.equal(page._session.mode, 'result');
  await settle();
  await settle();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].songId, 'beatucada');
  assert.equal(submitted[0].chartVersion, 1);
  assert.equal(submitted[0].perfect + submitted[0].good + submitted[0].ok + submitted[0].miss, 32);
  assert.equal(page._session.saved, '已上榜 · 第 2 名');
  await page._save(page._session.game.result(), page._session.model().state);
  assert.equal(submitted.length, 1, 'the same run is not submitted twice');
  page.onUnload();
  assert.deepEqual(fixture.errors, []);
});
