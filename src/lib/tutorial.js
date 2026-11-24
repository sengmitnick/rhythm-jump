import { getCourse, LANE_BY_ACTION } from './courses.js';

export const TUTORIAL_ACTIONS = Object.freeze(['dodge-left', 'dodge-right', 'jump']);
export const TUTORIAL_DEMO_MS = 1500;
export const TUTORIAL_SUCCESS_MS = 850;

const { bpm, durationMs, root } = getCourse('practice');
const JUMP_PUSH = 12;
const JUMP_ENTER = 2.6;
const JUMP_EXIT = 5.3;
const JUMP_SUPPORT_MS = 120;
const JUMP_PUSH_WINDOW_MS = 360;
const JUMP_LANDING_WINDOW_MS = 300;
const JUMP_SAMPLE_GAP_MS = 120;

export function createTutorialCourse() {
  return {
    id: 'tutorial', title: '动作练习', version: 1, bpm, durationMs, root, events: [], sections: [],
  };
}

// atMs marks when the demo hands control to the learner; the exercise has no deadline.
export function tutorialCue(action, elapsedMs = 0) {
  const atMs = Math.round(elapsedMs + TUTORIAL_DEMO_MS);
  return { id: `tutorial-${action}-${atMs}`, atMs, action, lane: LANE_BY_ACTION.get(action), kind: 'note' };
}

// A short hop often leaves the strict near-zero band before normal load
// returns. Observe a push, sustained unloading, and landing separately so
// the beginner does not have to jump harder or hit a preselected frame.
export class TutorialJump {
  constructor() {
    this.timestamp = null;
    this.lastAt = null;
    this.pushAt = null;
    this.airAt = null;
    this.contact = null;
  }

  sample(accel, now, sideways) {
    const stamp = accel.sensorTimestamp;
    if (Number.isFinite(stamp) && stamp === this.timestamp) return null;
    this.timestamp = Number.isFinite(stamp) ? stamp : null;
    const previousAt = this.lastAt;
    this.lastAt = now;
    if (previousAt !== null && now - previousAt > JUMP_SAMPLE_GAP_MS && !this.contact) {
      this.pushAt = null;
      this.airAt = null;
    }
    if (sideways) {
      this.pushAt = null; this.airAt = null; this.contact = null;
      return null;
    }

    const load = Math.hypot(accel.x, accel.y, accel.z);
    if (this.contact) {
      const { airMs, at } = this.contact;
      if (now - at > JUMP_LANDING_WINDOW_MS || load <= JUMP_ENTER) {
        this.contact = null;
        return { accepted: false, reason: 'landing', airMs, landing: load };
      }
      if (load >= JUMP_PUSH) {
        this.contact = null;
        return { accepted: true, reason: 'confirmed', airMs, landing: load };
      }
      return null;
    }

    if (this.airAt !== null) {
      if (load <= JUMP_EXIT) {
        if (now - this.airAt > 500) { this.pushAt = null; this.airAt = null; }
        return null;
      }
      const airMs = (previousAt + now) / 2 - this.airAt;
      this.airAt = null;
      if (airMs >= JUMP_SUPPORT_MS) {
        this.pushAt = null;
        if (load >= JUMP_PUSH) return { accepted: true, reason: 'confirmed', airMs, landing: load };
        this.contact = { airMs, at: now };
      } else if (airMs >= 40) {
        return { accepted: false, reason: 'short-air', airMs, landing: load };
      }
      return null;
    }

    if (load >= JUMP_PUSH) this.pushAt = now;
    if (load <= JUMP_ENTER && this.pushAt !== null && now - this.pushAt <= JUMP_PUSH_WINDOW_MS) this.airAt = now;
    return null;
  }
}
