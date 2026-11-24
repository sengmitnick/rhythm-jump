const AIM_FOCUS_MS = 180;
const AIM_CONFIRM_MS = 3000;
const SWIPE_HOLD_MS = 700;
const MAX_POSE_AGE_MS = 300;
const MAX_FRAME_GAP_MS = 250;
const NEUTRAL_X = 298;
const NEUTRAL_Y = 175;

const KEYS = new Map([
  ['ArrowUp', 'previous'], ['Up', 'previous'], ['ArrowLeft', 'previous'], ['Left', 'previous'],
  ['ArrowDown', 'next'], ['Down', 'next'], ['ArrowRight', 'next'], ['Right', 'next'],
  ['Enter', 'confirm'], ['NumpadEnter', 'confirm'],
  ['Backspace', 'back'], ['Escape', 'back'], ['Esc', 'back'], ['Back', 'back'],
  ['BrowserBack', 'back'], ['GoBack', 'back'], ['AndroidBack', 'back'],
]);

export function templeKey(event) {
  for (const value of [event?.code, event?.key, event?.detail?.code, event?.detail?.key]) {
    if (KEYS.has(value)) return KEYS.get(value);
  }
  const nativeCode = event?.keyCode ?? event?.which ?? event?.detail?.keyCode;
  if ([4, 8, 27, 166].includes(nativeCode)) return 'back';
  return null;
}

export function menuTargets(songCount) {
  return [
    ...Array.from({ length: songCount }, (_, index) => ({
      focus: 'song', index, x: 26, y: 96 + 59 * index, w: 258, h: 48,
    })),
    { focus: 'leaderboard', index: -1, x: 310, y: 109, w: 148, h: 60 },
    { focus: 'tutorial', index: -1, x: 310, y: 193, w: 148, h: 60 },
  ];
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class MenuNavigation {
  constructor(songCount) {
    this.targets = menuTargets(songCount);
    this.target = this.targets[0];
    this.songIndex = 0;
    this.resetAim();
  }

  get focus() { return this.target.focus; }

  resetAim() {
    this.cursor = null;
    this.candidate = null;
    this.aimAt = 0;
    this.updatedAt = null;
    this.dwellProgress = 0;
    this.manualUntil = 0;
    this.ignoredTarget = null;
    this.confirmed = false;
  }

  focusOn(target) {
    this.target = target;
    if (target.focus === 'song') this.songIndex = target.index;
  }

  step(delta, now) {
    const next = (this.targets.indexOf(this.target) + delta + this.targets.length) % this.targets.length;
    // A swipe takes priority until the player aims elsewhere. Keeping the
    // head still on the prior row must not immediately undo the selection.
    this.ignoredTarget = this.candidate || this.ignoredTarget || this.target;
    this.candidate = null;
    this.dwellProgress = 0;
    this.cursor = null;
    this.manualUntil = now + SWIPE_HOLD_MS;
    this.focusOn(this.targets[next]);
  }

  update(pose, now) {
    const frameGap = this.updatedAt === null ? 0 : now - this.updatedAt;
    this.updatedAt = now;
    if (!pose?.valid || pose.ageMs > MAX_POSE_AGE_MS || !Number.isFinite(pose.yaw) ||
        !Number.isFinite(pose.pitch) || now < this.manualUntil) {
      this.cursor = null;
      this.candidate = null;
      this.dwellProgress = 0;
      return false;
    }
    const x = clamp(NEUTRAL_X + 405 * pose.yaw, 0, 480);
    const y = clamp(NEUTRAL_Y - 365 * pose.pitch, 0, 352);
    this.cursor = { x: Math.round(x), y: Math.round(y) };
    let target = this.targets.find(box => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
    if (target === this.ignoredTarget) target = null;
    else this.ignoredTarget = null;
    if (target !== this.candidate || frameGap > MAX_FRAME_GAP_MS) {
      this.candidate = target;
      this.aimAt = now;
      this.confirmed = false;
    }
    const held = target ? now - this.aimAt : 0;
    this.dwellProgress = Math.min(1, held / AIM_CONFIRM_MS);
    if (held >= AIM_FOCUS_MS) this.focusOn(target);
    if (held < AIM_CONFIRM_MS || this.confirmed) return false;
    this.confirmed = true;
    return true;
  }

  focusAimed(pose, now) {
    this.update(pose, now);
    if (this.candidate) this.focusOn(this.candidate);
  }
}
