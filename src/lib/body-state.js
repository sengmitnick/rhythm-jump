import { normalizeQuaternion, rotateVectorByQuaternion } from './head-pose.js';

// Lateral cues use one short movement in the upright frame. The running
// position is useful for recentering, but cannot be used to score a cue.
// Remove gravity and the estimated arc around the neck from the head motion.
const DEFAULTS = Object.freeze({
  gravityAlpha: 0.08,
  // Gravity is frozen while the body accelerates hard, so a jump or a squat
  // does not drag the gravity estimate along with it.
  gravityFreezeAccel: 2.2,
  stillAccel: 0.6,
  stillMs: 160,
  sideEnter: 0.09,
  lateralStartAccel: 0.9,
  lateralReverseVelocity: 0.14,
  lateralRepeatVelocity: 0.18,
  lateralInputMs: 440,
  lateralQuietAccel: 0.45,
  lateralQuietMs: 110,
  lateralRearmMs: 80,
  lateralCenterSnap: 0.035,
  lateralGapMs: 100,
  lateralLossMs: 350,
  lateralStrokeMs: 950,
  enableLateralFlight: false,
  lateralLaunchSpeed: 0.35,
  lateralLaunchEstimateMs: 150,
  lateralCoastLimitMs: 350,
  lateralLandingLimitMs: 340,
  lateralMaxPosition: 0.65,
  lateralMaxVelocity: 2.0,
  enableDuck: true,
  // Height is the only trustworthy squat signal. Looking down must not count:
  // the target pad sits below the centre of view, so a player who simply glances
  // at it would otherwise be "crouched" for most of the level.
  liftEnter: -0.085,
  liftExit: -0.040,
  pitchFallback: -9,      // disabled on purpose; kept for the fallback path
  pitchExit: -9,
  // A deliberate drop also shows up as a downward impulse; it keeps the squat
  // state alive long enough for the height estimate to catch up.
  dropAccel: -3.5,
  dropHoldMs: 800,
  dropLiftLimit: 0.15,
  weightless: 2.6,
  landingAccel: 12,
});

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function removeNeckArc(distance, arc) {
  const direction = Math.sign(distance);
  return distance - direction * clamp(direction * arc, 0, Math.abs(distance));
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function unit(vector) {
  const length = Math.hypot(...vector);
  return length > 1e-6 ? vector.map(value => value / length) : null;
}
const finite = (...values) => values.every(Number.isFinite);
// Approximate offset (metres) of the sensor above and forward of the neck.
const NECK_TO_SENSOR = [0, 0.16, -0.08];
const MOTION_FEEDBACK_MS = 320;

export class BodyState {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.gravity = null;
    this.lastAt = null;
    this.velocity = 0;
    this.lift = 0;
    this.stillMs = 0;
    this.airborne = false;
    this.lateralReference = null;
    this.worldGravity = null;
    this.worldUp = null;
    this.worldRight = null;
    this.neutralNeckOffset = 0;
    this.resetSide();
    this.pitch = 0;
    this.headRoll = 0;
    this.action = 'stand';
    this.since = -Infinity;
    this.dropAt = -Infinity;
    this.wStart = null; this.airPeak = 0; this.lastJump = null;
    this.satisfied = { jump: false, duck: false, 'dodge-left': false, 'dodge-right': false };
    this.sinceByAction = { jump: null, duck: null, 'dodge-left': null, 'dodge-right': null };
    this.samples = 0;
    this.peakLift = 0;
  }

  resetSide() {
    this.side = 0;
    this.sidePosition = 0;
    this.sideVelocity = 0;
    this.lateralAccel = 0;
    this.lateralStillMs = 0;
    this.lastSideAt = null;
    this.strokeAt = null;
    this.strokeDistance = 0;
    this.strokeDirection = 0;
    this.strokeFired = false;
    this.strokeBrakeImpulse = 0;
    this.strokeNeckStart = 0;
    this.lastNeckOffset = null;
    this.lateralMove = null;
    this.lastMotion = null;
    this.lateralFlightDirection = 0;
    this.lateralLandingAt = null;
  }

  // Calibrate from upright, then zero the displacement again after warmup by
  // calling without a quaternion. The calibrated direction stays fixed while
  // the wearer looks around.
  calibrate(now = 0, quaternion, worldGravity = null) {
    const reference = normalizeQuaternion(quaternion);
    if (reference) {
      this.lateralReference = reference;
      this.worldGravity = null;
      this.worldUp = null;
      this.worldRight = null;
      const g = this.gravity;
      this.setWorldGravity(worldGravity ?? (g && rotateVectorByQuaternion([g.x, g.y, g.z], reference)));
    }
    this.lift = 0;
    this.velocity = 0;
    this.resetSide();
    this.action = 'stand';
    this.since = Number.isFinite(now) ? now : 0;
    this.satisfied = { jump: false, duck: false, 'dodge-left': false, 'dodge-right': false };
    this.sinceByAction = { jump: null, duck: null, 'dodge-left': null, 'dodge-right': null };
    return true;
  }

  setWorldGravity(worldGravity) {
    if (!worldGravity || !this.lateralReference || !finite(...worldGravity)) return;
    const magnitude = Math.hypot(...worldGravity);
    if (magnitude < 8.5 || magnitude > 11.2) return;
    const up = unit(worldGravity);
    const right = rotateVectorByQuaternion([1, 0, 0], this.lateralReference);
    const rightVertical = dot(right, up);
    const horizontalRight = right.map((value, index) => value - up[index] * rightVertical);
    if (Math.hypot(...horizontalRight) < 0.5) return;
    this.worldGravity = worldGravity;
    this.worldUp = up;
    this.worldRight = unit(horizontalRight);
    this.neutralNeckOffset = dot(rotateVectorByQuaternion(NECK_TO_SENSOR, this.lateralReference), this.worldRight);
  }

  addLateralTravel(travel, strokeTravel, neckOffset, now) {
    const o = this.options;
    this.sidePosition = clamp(this.sidePosition + travel, -o.lateralMaxPosition, o.lateralMaxPosition);
    this.strokeDistance += strokeTravel;
    const distance = removeNeckArc(this.strokeDistance, neckOffset - this.strokeNeckStart);
    if (!this.strokeFired && this.strokeDirection * distance >= o.sideEnter) {
      this.strokeFired = true;
      this.lateralMove = { action: this.strokeDirection < 0 ? 'dodge-left' : 'dodge-right', at: now, distance };
      this.lastMotion = this.lateralMove;
    }
  }

  sampleLateralFlight(dt, now, neckOffset, weightless) {
    const o = this.options;
    if (!o.enableLateralFlight) {
      if (!weightless && !this.airborne) return false;
      this.sideVelocity = 0;
      this.strokeAt = null;
      return true;
    }
    // A plausible sideways launch has already gathered directed velocity while
    // grounded. Airborne acceleration alone provides no direction evidence.
    if (weightless && !this.airborne) {
      this.lateralLandingAt = null;
      const speed = this.strokeDirection * this.sideVelocity;
      const distance = this.strokeDirection * removeNeckArc(this.strokeDistance, neckOffset - this.strokeNeckStart);
      this.lateralFlightDirection = dt && this.strokeAt !== null && now - this.strokeAt <= o.lateralStrokeMs &&
        speed >= o.lateralLaunchSpeed && distance + speed * o.lateralLaunchEstimateMs / 1000 >= o.sideEnter
        ? this.strokeDirection : 0;
    }
    if (weightless) {
      this.lateralStillMs = 0;
      if (dt && this.lateralFlightDirection && this.strokeAt !== null &&
          (this.wStart === null || now - this.wStart <= o.lateralCoastLimitMs)) {
        const travel = this.sideVelocity * dt;
        this.addLateralTravel(travel, travel, neckOffset, now);
      } else {
        this.sideVelocity = 0;
        this.strokeAt = null;
      }
      return true;
    }
    if (this.airborne && this.lateralFlightDirection) this.lateralLandingAt = now;
    if (this.lateralLandingAt === null) return this.airborne;

    // The first opposing force after contact brakes the hop. Cap at zero so
    // that force cannot by itself create a fresh stroke in the other direction.
    if (!dt || this.lateralStillMs >= o.lateralQuietMs || now - this.lateralLandingAt >= o.lateralLandingLimitMs) {
      this.sideVelocity = 0;
      this.strokeAt = null;
      this.lateralFlightDirection = 0;
      this.lateralLandingAt = null;
      return !dt;
    }
    const direction = this.lateralFlightDirection;
    const previous = this.sideVelocity;
    const brake = Math.min(0, direction * this.lateralAccel);
    this.sideVelocity = direction * Math.max(0, direction * previous + brake * dt);
    if (this.strokeAt !== null) {
      const travel = (previous + this.sideVelocity) * dt * 0.5;
      this.addLateralTravel(travel, travel, neckOffset, now);
    }
    return true;
  }

  sampleGroundLateral(dt, now, neckOffset, quiet, vertical) {
    const o = this.options;
    const interrupted = !dt || Math.abs(vertical) > 8;
    const speed = Math.abs(this.sideVelocity);
    // A measured opposing brake plus quiet makes the same small residual
    // speed safe to clear here as when arming the next same-direction stroke.
    const braked = this.strokeBrakeImpulse >= o.lateralReverseVelocity;
    const nearStop = speed < o.lateralReverseVelocity || (braked && speed <= o.lateralRepeatVelocity);
    const stopped = this.lateralStillMs >= o.lateralQuietMs ||
      (this.strokeFired && this.lateralStillMs >= o.lateralRearmMs && nearStop);
    if (interrupted || stopped) {
      const settling = !interrupted && this.strokeAt !== null;
      this.sideVelocity = 0;
      this.strokeAt = null;
      return settling;
    }

    const signedAccel = this.strokeDirection * this.lateralAccel;
    if (this.strokeAt !== null && this.strokeFired && signedAccel < -o.lateralQuietAccel) {
      this.strokeBrakeImpulse -= signedAccel * dt;
    }
    // Repeated steps can brake and accelerate again without a quiet gap.
    // Require observed braking and near-zero speed before arming a new step.
    const expired = this.strokeAt !== null && now - this.strokeAt >= o.lateralStrokeMs;
    const repeat = this.strokeAt !== null && this.strokeFired &&
      this.strokeBrakeImpulse >= o.lateralReverseVelocity && Math.abs(this.sideVelocity) <= o.lateralRepeatVelocity &&
      signedAccel >= o.lateralStartAccel;
    if (expired && !repeat && signedAccel > -o.lateralStartAccel) {
      // An aged stroke needs a new reversal, brake-and-repeat, or quiet gap.
      this.sideVelocity = 0;
    } else if (this.strokeAt !== null || Math.abs(this.lateralAccel) >= o.lateralStartAccel) {
      const previous = repeat || (expired && this.strokeDirection * this.sideVelocity > 0) ? 0 : this.sideVelocity;
      if (!quiet) this.sideVelocity = clamp(previous + this.lateralAccel * dt, -o.lateralMaxVelocity, o.lateralMaxVelocity);
      const direction = Math.sign(this.sideVelocity);
      const reversed = direction !== this.strokeDirection && Math.abs(this.sideVelocity) >= o.lateralReverseVelocity &&
        direction * this.lateralAccel >= o.lateralStartAccel;
      if (this.strokeAt === null || reversed || repeat) {
        this.strokeAt = now;
        this.strokeDirection = direction;
        this.strokeDistance = 0;
        this.strokeFired = false;
        this.strokeBrakeImpulse = 0;
        this.strokeNeckStart = this.lastNeckOffset ?? neckOffset;
      }
      if (!expired || reversed || repeat) {
        const travel = (previous + this.sideVelocity) * dt * 0.5;
        this.addLateralTravel(travel, reversed ? this.sideVelocity * dt * 0.5 : travel, neckOffset, now);
      }
    }
    return false;
  }

  sampleSide(acceleration, quaternion, now, vertical, weightless) {
    const o = this.options;
    const gapMs = this.lastSideAt === null ? 0 : now - this.lastSideAt;
    const dt = gapMs > 0 && gapMs <= o.lateralGapMs ? gapMs / 1000 : 0;
    this.lastSideAt = now;
    this.lateralAccel = dot(acceleration, this.worldRight);
    const neckOffset = dot(rotateVectorByQuaternion(NECK_TO_SENSOR, quaternion), this.worldRight);

    const quiet = Math.abs(this.lateralAccel) < o.lateralQuietAccel;
    this.lateralStillMs = quiet ? this.lateralStillMs + dt * 1000 : 0;
    const flight = this.sampleLateralFlight(dt, now, neckOffset, weightless);
    const settling = !flight && this.sampleGroundLateral(dt, now, neckOffset, quiet, vertical);

    this.lastNeckOffset = neckOffset;
    this.side = removeNeckArc(this.sidePosition, neckOffset - this.neutralNeckOffset);
    // A return that settles within a few centimetres of centre is neutral.
    // Remove the small integration residual before the next sideways stroke.
    if (settling && Math.abs(this.side) < o.lateralCenterSnap) {
      this.sidePosition -= this.side;
      this.side = 0;
    }
  }

  sample(reading, now) {
    if (!Number.isFinite(now)) return this.snapshot(now);
    // A resumed orientation stream starts the lateral estimate from neutral.
    // Check before accepting the new reading so a skipped callback cannot hide
    // the disconnect.
    if (this.lastSideAt !== null && now - this.lastSideAt > this.options.lateralLossMs) this.resetSide();
    const accel = reading?.accel;
    const pose = reading?.pose;
    if (pose && finite(pose.roll)) this.headRoll = pose.roll;
    if (pose && finite(pose.pitch)) this.pitch = pose.pitch;

    if (accel && finite(accel.x, accel.y, accel.z)) {
      if (!this.gravity) this.gravity = { x: accel.x, y: accel.y, z: accel.z };
      const linear = {
        x: accel.x - this.gravity.x,
        y: accel.y - this.gravity.y,
        z: accel.z - this.gravity.z,
      };
      const dt = this.lastAt === null ? 0 : clamp((now - this.lastAt) / 1000, 0, 0.12);
      this.lastAt = now;
      this.samples++;

      const g = this.gravity;
      const gLength = Math.hypot(g.x, g.y, g.z) || 1;
      const quaternion = reading.quaternion;
      if (quaternion && !this.worldGravity && this.lateralReference) {
        this.setWorldGravity(rotateVectorByQuaternion([g.x, g.y, g.z], this.lateralReference));
      }
      const world = quaternion && this.worldGravity ? rotateVectorByQuaternion([accel.x, accel.y, accel.z], quaternion) : null;
      const worldLinear = world ? world.map((value, index) => value - this.worldGravity[index]) : null;
      const energy = worldLinear ? Math.hypot(...worldLinear) : Math.hypot(linear.x, linear.y, linear.z);
      // Positive means the head is accelerating upward.
      const vertical = worldLinear ? dot(worldLinear, this.worldUp) : (linear.x * g.x + linear.y * g.y + linear.z * g.z) / gLength;

      // Weightlessness and landing are measured from the raw acceleration norm.
      const rawMagnitude = Math.hypot(accel.x, accel.y, accel.z);
      const weightless = rawMagnitude < this.options.weightless;
      if (worldLinear) this.sampleSide(worldLinear, quaternion, now, vertical, weightless);

      this.velocity += vertical * dt;
      this.lift = clamp(this.lift + this.velocity * dt, -1.2, 1.2);
      this.peakLift = Math.max(this.peakLift, this.lift);

      if (!this.airborne && vertical < this.options.dropAccel && Math.abs(this.lift) < this.options.dropLiftLimit) {
        this.dropAt = now;
      }
      // Bleed off integration drift, but only a few centimetres of it: a real
      // squat has to survive untouched.
      if (this.stillMs > this.options.stillMs && Math.abs(this.lift) < 0.06) this.lift *= 0.99;
      // Airtime is measured straight from weightlessness rather than from the
      // integrated height, because the height estimate is the part that drifts.
      if (weightless && this.wStart === null) { this.wStart = now; this.airPeak = this.lift; }
      else if (weightless) this.airPeak = Math.max(this.airPeak, this.lift);
      else if (this.wStart !== null) {
        const airMs = now - this.wStart;
        this.lastJump = { airMs, landing: rawMagnitude, rise: Math.max(0, this.airPeak - this.lift), at: now };
        this.wStart = null;
      }
      this.airborne = this.wStart !== null;

      if (energy < this.options.stillAccel && !weightless) this.stillMs += dt * 1000;
      else this.stillMs = 0;
      // Zero-velocity update: while the body is not moving, position stops
      // drifting. This is what lets a held squat stay at -0.3 m for seconds.
      if (this.stillMs > this.options.stillMs && Math.abs(this.velocity) < 0.6) {
        this.velocity = 0;
        if (!this.airborne && Math.abs(this.lift) < 0.02) this.lift = 0;
      }

      // Only frozen while moving hard; a gentle drift keeps the estimate honest.
      if (Math.hypot(linear.x, linear.y, linear.z) < this.options.gravityFreezeAccel) {
        const alpha = this.options.gravityAlpha;
        g.x += (accel.x - g.x) * alpha;
        g.y += (accel.y - g.y) * alpha;
        g.z += (accel.z - g.z) * alpha;
      }
    }
    this.update(now);
    return this.snapshot(now);
  }

  update(now) {
    const o = this.options;
    const previous = this.action;
    if (this.lateralMove && !this.hasLateralMove(this.lateralMove.action, now)) this.lateralMove = null;
    const left = this.lateralMove?.action === 'dodge-left';
    const right = this.lateralMove?.action === 'dodge-right';
    // A downward impulse only keeps an existing squat alive; it never creates
    // one, or every head bob would read as a squat.
    const dropped = Number.isFinite(this.dropAt) && now - this.dropAt < o.dropHoldMs;
    const crouched = o.enableDuck && (this.lift < (previous === 'duck' ? o.liftExit : o.liftEnter) ||
      this.pitch < (previous === 'duck' ? o.pitchExit : o.pitchFallback) ||
      (previous === 'duck' && dropped));
    // Each move is evaluated independently. The chart decides which one counts.
    this.satisfied = {
      jump: this.airborne && !this.lateralFlightDirection,
      duck: crouched,
      'dodge-left': left,
      'dodge-right': right,
    };
    for (const key of Object.keys(this.satisfied)) {
      if (this.satisfied[key] && this.sinceByAction[key] === null) this.sinceByAction[key] = now;
      else if (!this.satisfied[key]) this.sinceByAction[key] = null;
    }
    if (this.lateralMove) this.sinceByAction[this.lateralMove.action] = this.lateralMove.at;
    const deepSquat = this.lift < o.liftEnter * 1.6;
    let next = 'stand';
    if (this.satisfied.jump) next = 'jump';
    else if ((left || right) && (!crouched || !deepSquat)) next = left ? 'dodge-left' : 'dodge-right';
    else if (crouched) next = 'duck';
    if (next !== previous) {
      this.action = next;
      this.since = now;
    }
  }

  hasLateralMove(action, now) {
    const move = this.lateralMove;
    return move?.action === action && now >= move.at && now - move.at <= this.options.lateralInputMs &&
      this.lastSideAt !== null && now - this.lastSideAt <= this.options.lateralLossMs;
  }

  matches(action, now = this.lastAt) {
    if (action === 'dodge-left' || action === 'dodge-right') return this.hasLateralMove(action, now);
    return this.satisfied[action] === true;
  }

  consume(action, now) {
    if (!this.lateralMove || this.lateralMove.action !== action) return false;
    this.lateralMove = null;
    this.update(now);
    return true;
  }

  sinceFor(action) { return this.sinceByAction[action] ?? null; }

  motionFeedback(now) {
    const o = this.options;
    if (this.lastSideAt === null || now - this.lastSideAt > o.lateralLossMs) {
      return { motionDirection: null, motionPhase: 'unavailable' };
    }
    // Scoring consumes lateralMove immediately. Keep the display pulse on its
    // own clock so it is visible for both scored and unscored movements.
    const pulseAge = this.lastMotion ? now - this.lastMotion.at : Infinity;
    const motionDirection = pulseAge >= 0 && pulseAge <= MOTION_FEEDBACK_MS ? this.lastMotion.action : null;
    if (this.lateralLandingAt !== null) return { motionDirection, motionPhase: 'settling' };
    if (this.strokeAt === null) return { motionDirection, motionPhase: 'ready' };
    const driving = this.strokeDirection * this.lateralAccel;
    const coasting = this.airborne && this.lateralFlightDirection !== 0;
    const moving = coasting || (
      now - this.strokeAt < o.lateralStrokeMs && driving >= -o.lateralQuietAccel &&
      (Math.abs(this.sideVelocity) >= o.lateralReverseVelocity || driving >= o.lateralStartAccel)
    );
    return { motionDirection, motionPhase: moving ? 'moving' : 'settling' };
  }

  snapshot(now = null) {
    return {
      action: this.action,
      since: this.since,
      heldMs: Number.isFinite(now) && Number.isFinite(this.since) ? Math.max(0, now - this.since) : 0,
      lift: this.lift,
      side: this.side,
      sideVelocity: this.sideVelocity,
      sideReady: this.lastSideAt !== null,
      lateralMove: this.lateralMove,
      ...this.motionFeedback(Number.isFinite(now) ? now : this.lastAt),
      lateralAccel: this.lateralAccel,
      lateralStillMs: this.lateralStillMs,
      headRoll: this.headRoll,
      pitch: this.pitch,
      airborne: this.airborne,
      samples: this.samples,
    };
  }
}
