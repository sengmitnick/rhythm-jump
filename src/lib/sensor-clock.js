// Generic Sensor timestamps and performance.now() are monotonic but may use
// different origins. Learn their offset from the lowest observed delivery lag
// so queued callbacks retain the time at which the sample was captured.
const SCALES = [1, 1000, 0.001, 0.000001];
const MIN_SAMPLE_DELTA_MS = 0.5;
const MAX_SAMPLE_DELTA_MS = 250;

function chooseScale(rawDelta, arrivalDelta) {
  let best = null;
  for (const scale of SCALES) {
    const deltaMs = rawDelta * scale;
    if (deltaMs < MIN_SAMPLE_DELTA_MS || deltaMs > MAX_SAMPLE_DELTA_MS) continue;
    const error = Math.abs(deltaMs - Math.max(MIN_SAMPLE_DELTA_MS, arrivalDelta));
    if (!best || error < best.error) best = { scale, error };
  }
  return best?.scale ?? null;
}

export class SensorClock {
  constructor() { this.reset(); }

  reset() {
    this.scale = null;
    this.offsetMs = null;
    this.previousRaw = null;
    this.previousArrivalMs = null;
    this.firstRaw = null;
    this.firstArrivalMs = null;
    this.lastClockMs = null;
  }

  map(sensorTimestamp, arrivalMs) {
    if (!Number.isFinite(arrivalMs)) return { clockMs: arrivalMs, delayMs: 0, source: 'arrival', fresh: false };
    if (!Number.isFinite(sensorTimestamp)) {
      this.lastClockMs = arrivalMs;
      return { clockMs: arrivalMs, delayMs: 0, source: 'arrival', fresh: true };
    }

    if (this.previousRaw === sensorTimestamp) {
      return {
        clockMs: this.lastClockMs ?? arrivalMs,
        delayMs: Math.max(0, arrivalMs - (this.lastClockMs ?? arrivalMs)),
        source: this.scale === null ? 'arrival' : 'sensor',
        fresh: false,
      };
    }

    if (this.previousRaw !== null && (sensorTimestamp < this.previousRaw || arrivalMs < this.previousArrivalMs)) {
      this.reset();
    }
    if (this.firstRaw === null) {
      this.firstRaw = sensorTimestamp;
      this.firstArrivalMs = arrivalMs;
    }

    if (this.scale === null && this.previousRaw !== null) {
      const rawDelta = sensorTimestamp - this.previousRaw;
      const arrivalDelta = arrivalMs - this.previousArrivalMs;
      this.scale = chooseScale(rawDelta, arrivalDelta);
      if (this.scale !== null) {
        this.offsetMs = Math.min(
          this.firstArrivalMs - this.firstRaw * this.scale,
          arrivalMs - sensorTimestamp * this.scale,
        );
      }
    }

    let clockMs = arrivalMs;
    let source = 'arrival';
    if (this.scale !== null) {
      this.offsetMs = Math.min(this.offsetMs, arrivalMs - sensorTimestamp * this.scale);
      clockMs = Math.min(arrivalMs, sensorTimestamp * this.scale + this.offsetMs);
      if (this.lastClockMs !== null) clockMs = Math.max(this.lastClockMs, clockMs);
      source = 'sensor';
    }

    this.previousRaw = sensorTimestamp;
    this.previousArrivalMs = arrivalMs;
    this.lastClockMs = clockMs;
    return { clockMs, delayMs: Math.max(0, arrivalMs - clockMs), source, fresh: true };
  }
}
