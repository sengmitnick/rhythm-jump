// 3DoF head pose for the AIUI glasses.
//
// AbsoluteOrientationSensor reports [x, y, z, w] quaternions. The reference
// frame follows the approach extracted from 「突出重围」 and already used by
// world-play: rotate the calibrated and current forward vectors with the same
// gravity axis, then take yaw in that horizontal plane and pitch as the
// elevation difference. A calibration pose that was already looking down or
// tilting sideways therefore does not leak into horizontal turning.
//
// This module is deliberately free of host APIs so both the page and the tests
// can drive it with plain numbers.
export const TAU = Math.PI * 2;

// Positive yaw is a turn to the wearer's right; positive pitch is looking up.
export function wrapAngle(value) {
  let angle = value % TAU;
  if (angle <= -Math.PI) angle += TAU;
  else if (angle > Math.PI) angle -= TAU;
  return angle;
}

export function smoothAngle(previous, target, alpha) {
  return wrapAngle(previous + wrapAngle(target - previous) * alpha);
}

export function normalizeQuaternion(value) {
  if (!value || value.length !== 4) return null;
  const quaternion = Array.from(value);
  if (!quaternion.every(Number.isFinite)) return null;
  const length = Math.hypot(...quaternion);
  return length > 1e-9 ? quaternion.map(item => item / length) : null;
}

export function rotateVectorByQuaternion(vector, quaternion) {
  const [x, y, z] = vector;
  const q = normalizeQuaternion(quaternion);
  if (!q) return null;
  const [qx, qy, qz, qw] = q;
  const dot = qx * x + qy * y + qz * z;
  // v' = 2(u·v)u + (w²-u·u)v + 2w(u×v)
  const uu = qx * qx + qy * qy + qz * qz;
  const ww = qw * qw;
  const cx = qy * z - qz * y;
  const cy = qz * x - qx * z;
  const cz = qx * y - qy * x;
  return [
    2 * dot * qx + (ww - uu) * x + 2 * qw * cx,
    2 * dot * qy + (ww - uu) * y + 2 * qw * cy,
    2 * dot * qz + (ww - uu) * z + 2 * qw * cz,
  ];
}

// Hosts disagree on the world up axis: Android rotation vectors use world Z up,
// some older hosts use world Y up. Both keep device +Y along the wearer's head,
// so derive the real gravity axis by rotating device +Y into world space instead
// of assuming one convention. Returns null for a clearly tilted calibration.
export function detectUpAxis(reference) {
  const quaternion = normalizeQuaternion(reference);
  if (!quaternion) return null;
  const up = rotateVectorByQuaternion([0, 1, 0], quaternion);
  if (!up) return null;
  const absolute = up.map(Math.abs);
  const index = absolute.indexOf(Math.max(...absolute));
  if (absolute[index] < 0.75) return null;
  return absolute.map((value, axis) => (axis === index ? Math.sign(up[axis]) || 0 : 0));
}

export function multiplyQuaternions(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function invertQuaternion(q) { return [-q[0], -q[1], -q[2], q[3]]; }

// Signed rotation of `relative` about `axis`. This is the twist part of the
// tilt-twist decomposition, which is what a head lean actually is.
export function twistAbout(relative, axis) {
  const q = normalizeQuaternion(relative);
  const a = normalizeQuaternion([axis[0], axis[1], axis[2], 0]);
  if (!q || !a) return 0;
  const dot = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  return 2 * Math.atan2(dot, q[3]);
}

// Rotation axis of the quaternion that takes `from` to `to`, expressed in the
// frame of `from`. A left lean produces a vector along the wearer's forward
// axis, whichever device axis that happens to be.
export function rotationAxis(from, to) {
  const a = normalizeQuaternion(from), b = normalizeQuaternion(to);
  if (!a || !b) return null;
  const rel = multiplyQuaternions(invertQuaternion(a), b);
  const length = Math.hypot(rel[0], rel[1], rel[2]);
  if (length < 1e-6) return null;
  return [rel[0] / length, rel[1] / length, rel[2] / length, Math.acos(Math.max(-1, Math.min(1, rel[3]))) * 2];
}

export function relativeYawPitch(reference, current, rollAxis = null, rollSign = 1) {
  const baseQuaternion = normalizeQuaternion(reference);
  const currentQuaternion = normalizeQuaternion(current);
  if (!baseQuaternion || !currentQuaternion) return null;
  const base = rotateVectorByQuaternion([0, 0, -1], baseQuaternion);
  const look = rotateVectorByQuaternion([0, 0, -1], currentQuaternion);
  const rightNow = rotateVectorByQuaternion([1, 0, 0], currentQuaternion);
  const rightBase = rotateVectorByQuaternion([1, 0, 0], baseQuaternion);
  if (!base || !look || !rightNow || !rightBase) return null;
  const up = detectUpAxis(baseQuaternion) || [0, 0, 1];
  const dotUp = vector => vector[0] * up[0] + vector[1] * up[1] + vector[2] * up[2];
  const flatten = vector => {
    const depth = dotUp(vector);
    return [vector[0] - up[0] * depth, vector[1] - up[1] * depth, vector[2] - up[2] * depth];
  };
  const baseFlat = flatten(base), lookFlat = flatten(look);
  const baseLength = Math.hypot(...baseFlat), lookLength = Math.hypot(...lookFlat);
  let yaw = 0;
  if (baseLength > 1e-4 && lookLength > 1e-4) {
    const [bx, by, bz] = baseFlat.map(value => value / baseLength);
    const [lx, ly, lz] = lookFlat.map(value => value / lookLength);
    const cx = by * lz - bz * ly;
    const cy = bz * lx - bx * lz;
    const cz = bx * ly - by * lx;
    yaw = -Math.atan2(cx * up[0] + cy * up[1] + cz * up[2], bx * lx + by * ly + bz * lz);
  }
  const clamp = value => Math.max(-1, Math.min(1, value));
  const clean = value => (value === 0 ? 0 : value);
  // Roll is the head's left-right axis against gravity. It is absolute, so a
  // held lean neither drifts nor needs integration. Positive means the wearer
  // is tilting to their own right.
  //
  // When a lean axis has been measured on this device, roll is the twist of the
  // attitude change about that axis instead. The device's own X axis is not
  // guaranteed to point sideways on a pair of glasses, which is why the static
  // guess can sit at zero while the player is leaning hard.
  const roll = rollAxis
    ? rollSign * twistAbout(multiplyQuaternions(invertQuaternion(baseQuaternion), currentQuaternion), rollAxis)
    : -(Math.asin(clamp(dotUp(rightNow))) - Math.asin(clamp(dotUp(rightBase))));
  return {
    yaw: clean(wrapAngle(yaw)),
    pitch: clean(wrapAngle(Math.asin(clamp(dotUp(look))) - Math.asin(clamp(dotUp(base))))),
    roll: clean(roll),
    up,
  };
}

const DEFAULTS = Object.freeze({
  // Filter time constant in milliseconds. 80 ms removes sensor jitter without
  // making the tunnel lag visibly behind a deliberate head turn.
  smoothMs: 80,
  // A quiet orientation sensor should hold the last view, never snap back.
  staleMs: 600,
});

export class HeadPose {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.reference = null;
    this.latest = null;
    this.latestAt = -Infinity;
    this._pending = false;
    this._yaw = 0;
    this._pitch = 0;
    this._roll = 0;
    this._rollAxis = null;
    this._rollSign = 1;
    this._posedAt = null;
    this.samples = 0;
  }

  get calibrated() { return this.reference !== null; }

  // Reference an explicit attitude. The lean calibration ends with the head
  // still tilted, so forward must come from the upright pose captured before
  // the leans started, not from whatever was sampled last.
  setReference(quaternion, now = null) {
    const value = normalizeQuaternion(quaternion);
    if (!value) return false;
    this.reference = value;
    this._yaw = 0; this._pitch = 0; this._roll = 0;
    this._posedAt = Number.isFinite(now) ? now : this.latestAt;
    this._pending = false;
    return true;
  }

  // The lean axis is measured once, on the device, by asking the player to
  // tilt both ways. Everything afterwards is a twist about that axis.
  setRollAxis(axis, sign = 1) {
    const normalized = axis && normalizeQuaternion([axis[0], axis[1], axis[2], 0]);
    this._rollAxis = normalized ? [normalized[0], normalized[1], normalized[2]] : null;
    this._rollSign = sign < 0 ? -1 : 1;
    return this._rollAxis !== null;
  }

  // Accept one sensor quaternion. Returns true when it was a valid reading.
  // Before a calibration, the first valid reading also defines forward so a
  // late-starting sensor still yields a usable, centered view.
  sample(quaternion, now) {
    const value = normalizeQuaternion(quaternion);
    if (!value || !Number.isFinite(now)) return false;
    this.latest = value;
    this.latestAt = now;
    this.samples++;
    if (this._pending || !this.reference) {
      this.reference = value;
      this._pending = false;
      this._yaw = 0;
      this._pitch = 0;
      this._roll = 0;
      this._posedAt = now;
    }
    return true;
  }

  // Capture the latest attitude as forward. Called when the entry countdown
  // ends. If no reading has arrived yet, the next valid reading becomes the
  // reference instead of leaving the camera uncalibrated.
  calibrate(now = null) {
    if (!this.latest) {
      this._pending = true;
      return false;
    }
    this.reference = this.latest;
    this._yaw = 0;
    this._pitch = 0;
    this._roll = 0;
    this._posedAt = Number.isFinite(now) ? now : this.latestAt;
    this._pending = false;
    return true;
  }

  // Smoothed relative attitude. `valid` is false before calibration or while
  // the sensor is stale; callers should then keep their neutral view.
  pose(now) {
    if (!Number.isFinite(now) || !this.latest || !this.reference) {
      return {
        yaw: 0, pitch: 0, roll: 0, valid: false, stale: false, calibrated: false,
        ageMs: null, samples: this.samples,
      };
    }
    const ageMs = now - this.latestAt;
    const stale = ageMs > this.options.staleMs;
    const target = stale ? null : relativeYawPitch(this.reference, this.latest, this._rollAxis, this._rollSign);
    const dt = this._posedAt === null ? 16 : Math.max(0, Math.min(200, now - this._posedAt));
    this._posedAt = now;
    const alpha = 1 - Math.exp(-dt / this.options.smoothMs);
    if (target) {
      this._yaw = smoothAngle(this._yaw, target.yaw, alpha);
      this._pitch += (target.pitch - this._pitch) * alpha;
      this._roll += (target.roll - this._roll) * alpha;
    }
    return {
      yaw: this._yaw, pitch: this._pitch, roll: this._roll, valid: !stale, stale,
      calibrated: true, ageMs, samples: this.samples,
    };
  }
}
