import { ENABLE_DUCK, getCourses } from './courses.js';
import { Game, PERFECT_MS, GOOD_MS, OK_MS, TIMING_VERSION } from './game.js';
import { BodyState } from './body-state.js';
import { invertQuaternion, normalizeQuaternion, rotateVectorByQuaternion, rotationAxis } from './head-pose.js';
import { spatialCourses } from './spatial.js';
import { createTutorialCourse, tutorialCue, TutorialJump, TUTORIAL_ACTIONS, TUTORIAL_DEMO_MS, TUTORIAL_SUCCESS_MS } from './tutorial.js';

// One session owns the audio clock, the chart, the posture estimate and the
// judgement. The page only feeds raw sensor readings in and draws the model out.
const CAL_STILL_RAD = 0.10;
const CAL_STILL_MS = 500;
const CAL_ACCEL_TOLERANCE = 0.65;
// The device's +Y points up when the glasses are worn. Real neutral captures
// have reached 22°, so leave room for fit and a comfortable gaze angle.
const CAL_MIN_UPRIGHT_Y = Math.cos(35 * Math.PI / 180);
const CAL_TIMEOUT_MS = 8000;
const CAL_FRESH_MS = 140;
const IMU_INTERRUPTION_MS = 350;
const READY_STILL_MS = 180;
const REUSE_ANGLE_RAD = 0.18;
const TUTORIAL_FINISH_MS = 1100;

// Airtime and landing describe the jump observed by the glasses.
const JUMP_MIN_AIR_MS = 150;
const JUMP_MIN_LANDING = 12;

function attitudeChange(from, to) {
  const angle = rotationAxis(from, to)?.[3] ?? 0;
  return Math.min(angle, 2 * Math.PI - angle);
}

function calibrationPhase(hint = '') {
  return { quat: null, gravity: null, worldGravity: [0, 0, 0], heldAt: null, sampledAt: null, samples: 0, hint };
}

export class Session {
  constructor({ audio = null, clock = null, onResult = () => {}, onTrace = null,
    tutorialComplete = false, onTutorialComplete = () => {}, onTutorialRepeat = () => {}, requireUpright = false,
    rawTraceIntervalMs = 0 } = {}) {
    this.audio = audio;
    this.clock = clock || (() => audio ? audio.now() : performance.now());
    this.onResult = onResult;
    this.courses = spatialCourses(getCourses()); this.selected = 0; this.mode = 'home'; this.source = 'keyboard';
    this.body = new BodyState({ enableDuck: ENABLE_DUCK }); this.message = ''; this.saved = ''; this.generation = 0;
    this.lastHit = null; this.lastSample = null; this.lastState = this.body.snapshot();
    this.onTrace = onTrace; this._traceOpen = false; this._tracedJudgements = 0;
    this.rawTraceIntervalMs = Number.isFinite(rawTraceIntervalMs) ? Math.max(0, rawTraceIntervalMs) : 0;
    this.postureCounts = { stand: 0, jump: 0, duck: 0, 'dodge-left': 0, 'dodge-right': 0 };
    this.baseQuaternion = null; this._lastQuat = null; this._lastPairAt = null; this._lastPairSensorTimestamp = null;
    this.calibrationReady = false; this.calibrationStep = null;
    this.requireUpright = requireUpright;
    this.tutorialComplete = tutorialComplete; this.onTutorialComplete = onTutorialComplete; this.tutorial = null;
    this.onTutorialRepeat = onTutorialRepeat;
    this.weakJumps = 0;
    this._phase = null;
  }
  trace(type, data = {}, now) {
    if (!this.onTrace || !this._traceOpen) return;
    now ??= this.clock();
    try { this.onTrace({ type, clockMs: now, elapsedMs: this.game ? this.game.time(now) : null, mode: this.mode, ...data }); }
    catch { /* research capture must never change gameplay */ }
  }
  _traceJudgements(now = this.clock()) {
    if (!this.onTrace || !this._traceOpen || !this.game) return;
    while (this._tracedJudgements < this.game.judgements.length) {
      const judgement = this.game.judgements[this._tracedJudgements++];
      const event = this.game.course.events.find(event => event.id === judgement.id);
      this.trace('judgement', { judgement, expected: event }, now);
    }
  }
  _endTrace(reason, result = null) {
    this._traceJudgements(); this.trace('end', { reason, result }); this._traceOpen = false;
  }
  select(delta) { if (this.mode === 'home') this.selected = (this.selected + delta + this.courses.length) % this.courses.length; }
  // The leaderboard is a view, not a round: keep the result snapshot so closing
  // it returns to the result screen it was opened from.
  openLeaderboard() {
    if (this.mode !== 'home' && this.mode !== 'result') return false;
    this._leaderboardReturn = this.mode;
    this.mode = 'leaderboard';
    this.message = '';
    return true;
  }
  closeLeaderboard() {
    if (this.mode !== 'leaderboard') return;
    this.mode = this._leaderboardReturn || 'home';
    this._leaderboardReturn = null;
  }
  async start(source = this.source, { tutorial = false } = {}) {
    const generation = ++this.generation; this.source = source; this.message = ''; this.saved = '';
    const course = tutorial ? createTutorialCourse() : this.courses[this.selected];
    // The course has to be known before preparing: if it carries a recording,
    // prepare() decides the clock source from it.
    try { this.audio?.setCourse?.(course); } catch { /* audio is optional */ }
    try { await this.audio?.prepare(); } catch { this.message = '声音暂不可用，仍可继续跟拍'; }
    if (generation !== this.generation) return;
    if (this._traceOpen) this._endTrace('restarted');
    const now = this.clock();
    // Trial lateral flight in the tutorial while keeping recording-based
    // formal charts on the established jump/grounded movement separation.
    this.body.options.enableLateralFlight = tutorial;
    this.game = new Game(course);
    this.tutorial = tutorial ? {
      index: 0, event: tutorialCue(TUTORIAL_ACTIONS[0]), phase: 'demo', phaseAt: 0,
      completed: false, attempt: 1, hint: '', jump: null,
    } : null;
    if (this.tutorial) course.events.push(this.tutorial.event);
    this._lastImuTrace = null; this._lastPoseTrace = null; this._lastPostureTrace = null;
    this.postureCounts = { stand: 0, jump: 0, duck: 0, 'dodge-left': 0, 'dodge-right': 0 };
    this.lastHit = null; this.weakJumps = 0;
    this._beginCalibration(now, source === 'imu' && this.calibrationReady && this.body.worldRight);
    this._tracedJudgements = 0; this._traceOpen = source === 'imu' && typeof this.onTrace === 'function';
    this.trace('start', { courseId: course.id, chartVersion: course.version, bpm: course.bpm, durationMs: course.durationMs,
      timing: { version: TIMING_VERSION, perfectMs: PERFECT_MS, goodMs: GOOD_MS, okMs: OK_MS }, body: { ...this.body.options }, events: course.events });
  }

  _beginCalibration(now, checkReference) {
    this.mode = 'calibrating'; this.countAt = now;
    this.calibrationStep = checkReference ? 'checking' : 'capture';
    // Each entry must use samples gathered for this attempt, even when a
    // stopped sensor is about to resume on the same glasses.
    this.lastSample = null; this._lastPairAt = null; this._lastQuat = null; this._lastPairSensorTimestamp = null;
    this._phase = calibrationPhase();
    this._calSignalLostAt = now;
    if (!checkReference) {
      this.calibrationReady = false;
      this.baseQuaternion = null;
      this.body.reset(); this.lastState = this.body.snapshot();
    }
  }

  interruptImu() {
    this.calibrationReady = false;
    this.lastSample = null; this._lastPairAt = null; this._lastQuat = null; this._lastPairSensorTimestamp = null;
    if (this.mode === 'calibrating') {
      this.calibrationStep = 'capture';
      this._phase = calibrationPhase();
      this._calSignalLostAt = this.clock();
    }
  }

  _checkImuContinuity(now) {
    if ((this.mode === 'playing' || this.mode === 'tutorial') && this._lastPairAt !== null &&
        now - this._lastPairAt > IMU_INTERRUPTION_MS) this.calibrationReady = false;
  }

  _neutralReady(now, requiredMs, requiredSamples) {
    if (this.source !== 'imu') {
      this._phase.heldAt ??= now;
      return now - this._phase.heldAt >= CAL_STILL_MS;
    }
    if (this._lastPairAt === null || now - this._lastPairAt > CAL_FRESH_MS) {
      this._phase = calibrationPhase();
      this._calSignalLostAt ??= now;
      if (now - this._calSignalLostAt >= CAL_TIMEOUT_MS) {
        this.calibrationReady = false;
        this.mode = 'sensor-error';
        this.message = '没有足够的传感器读数，请单击重试';
        this.trace('state', { state: 'sensor-error', reason: 'calibration_timeout' }, now);
      }
      return false;
    }
    this._calSignalLostAt = null;
    const phase = this._phase;
    return phase.samples >= requiredSamples && phase.sampledAt - phase.heldAt >= requiredMs;
  }

  _sampleNeutral(accel, quaternion, now) {
    const magnitude = Math.hypot(accel.x, accel.y, accel.z);
    if (this.requireUpright && accel.y < CAL_MIN_UPRIGHT_Y * magnitude) {
      this._phase = calibrationPhase('戴好眼镜，正视前方');
      return;
    }
    if (magnitude < 8.5 || magnitude > 11.2) {
      this._phase = calibrationPhase('请保持站稳');
      return;
    }

    let phase = this._phase;
    const gravity = phase.gravity;
    if (!gravity || now - phase.sampledAt > CAL_FRESH_MS || attitudeChange(phase.quat, quaternion) > CAL_STILL_RAD ||
        Math.hypot(gravity.x - accel.x, gravity.y - accel.y, gravity.z - accel.z) > CAL_ACCEL_TOLERANCE) {
      phase = this._phase = calibrationPhase('请保持站稳');
      phase.quat = quaternion;
      phase.gravity = { ...accel };
      phase.heldAt = now;
    }
    if (phase.sampledAt !== now) {
      // Average each sample in a common world frame. A small change of head
      // angle during the window would otherwise appear as lateral acceleration.
      const world = rotateVectorByQuaternion([accel.x, accel.y, accel.z], quaternion);
      phase.sampledAt = now;
      phase.samples++;
      for (const [index, axis] of ['x', 'y', 'z'].entries()) {
        phase.gravity[axis] += (accel[axis] - phase.gravity[axis]) / phase.samples;
        phase.worldGravity[index] += (world[index] - phase.worldGravity[index]) / phase.samples;
      }
    }
  }

  // One sensor reading: { accel } and/or { pose }. Either may be missing; the
  // posture estimate keeps whatever it last knew.
  sample(reading = {}) {
    const now = this.clock();
    // Adapters may hand in a bare accelerometer reading; normalise it.
    if (!reading.accel && [reading.x, reading.y, reading.z].every(Number.isFinite)) {
      reading = { accel: reading };
    }
    if (reading.accel) {
      const { x, y, z, sensorTimestamp } = reading.accel;
      const valid = [x, y, z].every(Number.isFinite);
      if (this._traceOpen && now - (this._lastImuTrace ?? -Infinity) >= this.rawTraceIntervalMs) {
        this._lastImuTrace = now;
        this.trace('imu', {
          sensor: 'accelerometer', axes: [x, y, z], sensorTimestamp: sensorTimestamp ?? null, valid,
          quaternion: reading.quaternion ?? null,
          orientationAgeMs: Number.isFinite(reading.orientationAgeMs) ? reading.orientationAgeMs : null,
        }, now);
      }
      if (!valid) return this.lastState;
      this.lastSample = now;
      if (this.source === 'imu') {
        const checking = this.mode === 'calibrating';
        const quaternion = checking ? normalizeQuaternion(reading.quaternion) : reading.quaternion;
        this._checkImuContinuity(now);
        const timestamp = Number.isFinite(sensorTimestamp) ? sensorTimestamp : null;
        if (quaternion && (timestamp === null || timestamp !== this._lastPairSensorTimestamp)) {
          this._lastPairAt = now;
          this._lastPairSensorTimestamp = timestamp;
          if (checking) {
            this._lastQuat = quaternion;
            this._sampleNeutral({ x, y, z }, quaternion, now);
          }
        }
      }
    }
    if (this._traceOpen && reading.pose && now - (this._lastPoseTrace ?? -Infinity) >= Math.max(200, this.rawTraceIntervalMs)) {
      this._lastPoseTrace = now;
      this.trace('pose', {
        yaw: reading.pose.yaw ?? null, pitch: reading.pose.pitch ?? null,
        roll: reading.pose.roll ?? null, valid: reading.pose.valid !== false,
      }, now);
    }
    const priorJump = this.body.lastJump;
    this.lastState = this.body.sample(reading, now);
    if (this.mode === 'playing' && this.body.lastJump && this.body.lastJump !== priorJump) {
      this.trace('jump', this.body.lastJump, now);
    }
    if (this.mode === 'playing') this.postureCounts[this.lastState.action] = (this.postureCounts[this.lastState.action] || 0) + 1;
    if (this._traceOpen && this.mode === 'playing' && now - (this._lastPostureTrace ?? -Infinity) >= 200) {
      this._lastPostureTrace = now;
      this.trace('posture', { ...this.lastState }, now);
    }
    if (this.mode === 'tutorial' && reading.accel) this._sampleTutorial(reading.accel, now);
    if (this.mode === 'playing') this.syncBody(now);
    return this.lastState;
  }

  // Resolve every cue that is due against the current posture.
  syncBody(now = this.clock()) {
    if (this.mode !== 'playing' || !this.game) return;
    for (let guard = 0; guard < 12; guard++) {
      // Judge against the estimator itself, not its snapshot: the snapshot is
      // a plain object without matches()/sinceFor(), which silently fell back
      // to the single display state and brought the old ranking back.
      const move = this.body.lateralMove;
      const hit = this.game.sync(this.body, now);
      if (!hit) break;
      if (hit.grade !== 'miss') {
        this.lastHit = hit;
        if (move && !this.body.lateralMove) {
          this.trace('lateral-hit', { cueId: hit.id, move }, now);
          this.lastState = this.body.snapshot(now);
        }
        if (hit.action === 'jump' && this.body.lastJump && now - this.body.lastJump.at < 2000) {
          const weak = this.body.lastJump.airMs < JUMP_MIN_AIR_MS || this.body.lastJump.landing < JUMP_MIN_LANDING;
          this.weakJumps = weak ? this.weakJumps + 1 : 0;
          if (this.weakJumps >= 2) this.message = '请站起来跳';
        } else if (hit.action !== 'jump') this.weakJumps = 0;
        try { this.audio?.feedback(hit.grade, this.game.combo); }
        catch { this.message = '声音暂不可用，仍可继续跟拍'; }
      }
    }
    this._traceJudgements(now);
  }

  tick() {
    const now = this.clock();
    if (this.source === 'imu') this._checkImuContinuity(now);
    if (this.mode === 'calibrating') {
      if (this.calibrationStep === 'checking') {
        if (!this._neutralReady(now, READY_STILL_MS, 5)) return;
        const [x, y, z] = this._phase.worldGravity;
        const [baseX, baseY, baseZ] = this.body.worldGravity;
        if (attitudeChange(this.baseQuaternion, this._lastQuat) <= REUSE_ANGLE_RAD &&
            Math.hypot(x - baseX, y - baseY, z - baseZ) <= CAL_ACCEL_TOLERANCE) {
          this.trace('calibration', { kind: 'reused', samples: this._phase.samples }, now);
          this._startChart(now);
          return;
        }
        this.calibrationStep = 'capture';
        this.calibrationReady = false;
      }
      if (!this._neutralReady(now, CAL_STILL_MS, 8)) return;
      this.baseQuaternion = this._lastQuat?.slice() ?? null;
      const worldGravity = this._phase.samples > 0 ? this._phase.worldGravity : null;
      if (worldGravity) {
        // Keep the local fallback in the final neutral frame too; the old
        // device-frame estimate may still reflect picking the glasses up.
        const [x, y, z] = rotateVectorByQuaternion(worldGravity, invertQuaternion(this.baseQuaternion));
        this.body.gravity = { x, y, z };
      }
      this.body.calibrate(now, this.baseQuaternion, worldGravity);
      this.lastState = this.body.snapshot(now);
      this.calibrationReady = !!this.body.worldRight;
      this.trace('calibration', {
        kind: 'neutral', posture: this.lastState, samples: this.body.samples,
        quaternion: this.baseQuaternion,
        gravity: this.body.gravity ? { ...this.body.gravity } : null,
        worldGravity: this.body.worldGravity,
      }, now);
      this._startChart(now);
      return;
    }
    if (this.mode === 'tutorial') {
      if (this.source === 'imu' && (this.lastSample === null || now - this.lastSample > 1200)) {
        this.interruptImu();
        this.pause(); this.message = '动作信号中断，已暂停'; return;
      }
      return this._advanceTutorial(now);
    }
    if (this.mode === 'playing') {
      if (this.source === 'imu' && (this.lastSample === null || now - this.lastSample > 1200)) {
        const lastSampleClockMs = this.lastSample;
        this.interruptImu();
        this.pause(); this.message = '动作信号中断，已暂停';
        this.trace('state', { state: 'signal-lost', lastSampleClockMs }, now); return;
      }
      // Judge before expiring, so a held posture is credited on the beat even
      // if this frame lands a little late.
      this.syncBody(now);
      this.game.tick(now);
      this._traceJudgements(now);
      const s = this.game.snapshot(now);
      try { this.audio?.tick(s.elapsedMs, s.course.bpm, s.combo, s.section); } catch { this.message = '声音暂不可用，仍可继续跟拍'; }
      if (s.status === 'finished') {
        this.mode = 'result'; this.audio?.stopMusic?.(); this.audio?.suspend().catch(() => {});
        this._endTrace('completed', { score: s.score, gameAccuracy: s.accuracy, maxCombo: s.maxCombo, perfect: s.perfect, good: s.good, ok: s.ok, miss: s.miss });
        this.onResult(this.game.result(), s);
      }
      return s;
    }
  }

  _startChart(now) {
    this.calibrationStep = null;
    this.body.calibrate(now);
    this.lastState = this.body.snapshot(now);
    this.game.start(now);
    this.mode = this.tutorial ? 'tutorial' : 'playing';
    if (this.tutorial) this.audio?.stopMusic?.();
    else this.audio?.startMusic?.(0);
    this.trace('state', { state: this.mode, posture: this.lastState }, now);
  }

  _queueTutorialCue(now) {
    const lesson = this.tutorial;
    lesson.phase = 'demo';
    lesson.phaseAt = this.game.time(now);
    lesson.hint = '';
    lesson.event = tutorialCue(TUTORIAL_ACTIONS[lesson.index], lesson.phaseAt);
    this.game.course.events.push(lesson.event);
    this.trace('chart', { event: lesson.event }, now);
  }

  _sampleTutorial(accel, now) {
    const lesson = this.tutorial;
    if (lesson.phase !== 'ready') return;
    const { action } = lesson.event;
    if (action === 'jump') {
      const jump = lesson.jump.sample(accel, now, this.body.lateralFlightDirection !== 0);
      if (!jump) return;
      this.trace('tutorial-jump', jump, now);
      if (!jump.accepted) {
        lesson.hint = jump.reason === 'short-air' ? '屈膝轻跳，双脚轻轻离地' : '轻跳后自然落地，站稳再试';
        this.trace('tutorial-action', { index: lesson.index, action, attempt: lesson.attempt, success: false, reason: jump.reason }, now);
        return;
      }
    } else {
      const move = this.body.lateralMove;
      if (!move || !this.body.matches(move.action, now)) return;
      this.body.consume(move.action, now);
      this.lastState = this.body.snapshot(now);
      if (action !== move.action) {
        lesson.hint = '跟着箭头，向这一侧移动';
        this.trace('tutorial-action', { index: lesson.index, action, attempt: lesson.attempt, success: false, detected: move.action, reason: 'wrong-side' }, now);
        return;
      }
      this.trace('lateral-hit', { cueId: lesson.event.id, move }, now);
    }

    const elapsed = this.game.time(now);
    const grade = action !== 'jump' && lesson.attempt === 1 ? 'good' : 'perfect';
    this.lastHit = this.game.judge(lesson.event, grade, null, elapsed);
    this._traceJudgements(now);
    lesson.phase = 'success';
    lesson.phaseAt = elapsed;
    lesson.hint = '';
    this.trace('tutorial-action', { index: lesson.index, action, attempt: lesson.attempt, success: true, posture: this.lastState }, now);
    try { this.audio?.feedback(grade, this.game.combo); } catch { /* Feedback sound is optional. */ }
    if (action === 'jump') {
      lesson.completed = true;
      if (!this.tutorialComplete) {
        this.tutorialComplete = true;
        this.onTutorialComplete();
      }
    }
  }

  _advanceTutorial(now) {
    const lesson = this.tutorial;
    const course = this.game.course;
    course.durationMs = Math.max(course.durationMs, now - this.game.origin + TUTORIAL_FINISH_MS);
    const elapsed = this.game.time(now) - lesson.phaseAt;
    if (lesson.phase === 'demo' && elapsed >= TUTORIAL_DEMO_MS) {
      this.body.calibrate(now);
      this.lastState = this.body.snapshot(now);
      lesson.phase = 'ready';
      lesson.phaseAt = this.game.time(now);
      lesson.jump = lesson.event.action === 'jump' ? new TutorialJump() : null;
    } else if (lesson.phase === 'success' && elapsed >= (lesson.completed ? TUTORIAL_FINISH_MS : TUTORIAL_SUCCESS_MS)) {
      if (lesson.completed) {
        this._endTrace('tutorial_completed');
        this.body.calibrate(now);
        this.lastState = this.body.snapshot(now);
        const state = this.game.snapshot(now);
        this.home();
        return state;
      }
      const { action } = lesson.event;
      if (lesson.attempt === 1) {
        lesson.attempt = 2;
        try { this.onTutorialRepeat(action); } catch { /* Speech is optional. */ }
      } else {
        lesson.index++;
        lesson.attempt = 1;
      }
      this._queueTutorialCue(now);
    }
    return this.game.snapshot(now);
  }

  // Keyboard adapter: a single instant press with no remembered posture.
  input(action, heldMs = 0, now = this.clock()) {
    if (this.mode !== 'playing') return null;
    const hit = this.game.input(action, now, { since: now - heldMs });
    this._traceJudgements(now);
    if (hit && hit.grade !== 'miss') { try { this.audio?.feedback(hit.grade, this.game.combo); } catch { this.message = '声音暂不可用，仍可继续跟拍'; } }
    return hit;
  }
  pause() {
    if (this.mode !== 'playing' && this.mode !== 'tutorial') return;
    this._pausedMode = this.mode;
    this.game.pause(this.clock()); this.mode = 'paused';
    this.audio?.stopMusic?.(); this.audio?.suspend().catch(() => {});
    this.trace('state', { state: 'paused' });
  }
  async confirm() {
    if (this.mode === 'leaderboard') { this.closeLeaderboard(); return; }
    if (this.mode === 'sensor-error') return this.start(this.source, { tutorial: !!this.tutorial });
    if (this.mode === 'home' || this.mode === 'result') return this.start();
    if (this.mode === 'playing' || this.mode === 'tutorial') { this.pause(); return; }
    if (this.mode === 'paused') {
      const generation = this.generation;
      if (this.source === 'imu' && (this.lastSample === null || this.clock() - this.lastSample > 1200)) { this.message = '等待动作信号恢复'; return; }
      await this.audio?.prepare();
      if (generation !== this.generation || this.mode !== 'paused') return;
      const now = this.clock();
      this.body.consume(this.body.lateralMove?.action, now);
      this.lastState = this.body.snapshot(now);
      this.game.resume(now); this.mode = this._pausedMode; this.message = '';
      if (this.mode === 'tutorial') {
        if (this.tutorial.jump) this.tutorial.jump = new TutorialJump();
        this.audio?.stopMusic?.();
      } else this.audio?.startMusic?.(this.game.time(this.clock()));
      this.trace('state', { state: 'resumed' });
      this.audio && (this.audio.lastBeat = -1);
    }
  }
  home() {
    this.generation++;
    const idle = this.mode !== 'playing' && this.mode !== 'tutorial';
    this.pause();
    this.audio?.stopMusic?.();
    if (idle) this.audio?.suspend?.()?.catch?.(() => {});
    if (this._traceOpen) this._endTrace('returned_home');
    this.tutorial = null;
    this.calibrationStep = null;
    this._leaderboardReturn = null;
    this.mode = 'home'; this.message = '';
  }
  model(state) {
    const now = this.clock();
    return {
      mode: this.mode, courses: this.courses, selected: this.selected, state: state ?? this.game?.snapshot(now), now,
      countdown: Math.max(0, 3 - (now - this.countAt) / 1000), message: this.message, source: this.source,
      tutorialComplete: this.tutorialComplete,
      calibrationReady: this.calibrationReady,
      tutorial: this.tutorial ? {
        action: this.tutorial.event.action, index: this.tutorial.index, count: TUTORIAL_ACTIONS.length,
        phase: this.tutorial.phase, phaseElapsedMs: Math.max(0, this.game.time(now) - this.tutorial.phaseAt),
        completed: this.tutorial.completed, attempt: this.tutorial.attempt, hint: this.tutorial.hint,
      } : null,
      stand: this.mode === 'calibrating'
        ? {
          step: this.calibrationStep,
          still: this._phase && this._phase.heldAt !== null
            ? Math.min(1, ((this._phase.sampledAt ?? now) - this._phase.heldAt) /
              (this.calibrationStep === 'checking' ? READY_STILL_MS : CAL_STILL_MS)) : 0,
          hint: this._phase ? this._phase.hint : '',
        }
        : null,
      saved: this.saved, hit: this.lastHit, body: this.lastState, posture: this.postureShare(),
    };
  }
  // Share of frames spent in each posture, as whole percents. Visible on the
  // result screen so a run that scored nothing still says why.
  postureShare() {
    const total = Object.values(this.postureCounts).reduce((sum, value) => sum + value, 0);
    if (!total) return null;
    return Object.fromEntries(Object.entries(this.postureCounts).map(([key, value]) => [key, Math.round(value / total * 100)]));
  }
  async destroy() { this.home(); await this.audio?.close(); }
}
