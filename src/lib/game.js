// Sensors supply the evidence for each cue. A lateral stroke is spent when it
// scores, while states such as airtime are evaluated at judgement time.
export const PERFECT_MS = 90;
export const GOOD_MS = 180;
export const OK_MS = 400;
export const EXPIRE_MS = OK_MS + 40;
export const TIMING_VERSION = 2;
const SCORES = { perfect: 1000, good: 500, ok: 250 };

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

export function gradeForDelta(deltaMs) {
  const distance = Math.abs(deltaMs);
  if (distance <= PERFECT_MS) return 'perfect';
  if (distance <= GOOD_MS) return 'good';
  if (distance <= OK_MS) return 'ok';
  return null;
}

export class Game {
  constructor(course) {
    this.course = course; this.status = 'ready'; this.elapsedMs = 0; this.origin = 0;
    this.judgements = []; this.done = new Set(); this.last = null; this.recent = [];
    this._usedMovement = new Map();
    this.energy = 0; this.startedAt = null; this.holdUntil = 0;
    this.inputNotBefore = -Infinity;
    this._totals = { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, ok: 0, miss: 0 };
  }
  start(now, delayMs = 0) {
    if (this.status === 'ready') {
      const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
      this.status = 'playing'; this.holdUntil = now + delay;
      this.inputNotBefore = delay > 0 ? this.holdUntil : -Infinity;
      this.origin = this.holdUntil; this.startedAt = this.origin; this.lastTickAt = this.holdUntil;
    }
  }
  time(now) {
    if (this.status !== 'playing') return this.elapsedMs;
    // A queued callback can carry a timestamp from just before resume. The
    // public playhead never rewinds below its frozen value.
    return Math.min(this.course.durationMs, Math.max(this.elapsedMs, now - this.origin));
  }
  movementTime(now) { return Math.min(this.course.durationMs, Math.max(0, now - this.origin)); }
  pause(now) {
    if (this.status === 'playing') {
      this.elapsedMs = this.time(now); this.status = 'paused';
    }
  }
  resume(now, delayMs = 0) {
    if (this.status === 'paused') {
      const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
      this.holdUntil = now + delay;
      this.inputNotBefore = delay > 0 ? this.holdUntil : -Infinity;
      this.origin = this.holdUntil - this.elapsedMs; this.lastTickAt = this.holdUntil;
      this.status = 'playing';
    }
  }
  next(now) {
    const t = this.time(now);
    let nearest = null;
    for (const event of this.course.events) {
      if (this.done.has(event.id) || event.atMs < t - OK_MS) continue;
      if (!nearest || Math.abs(event.atMs - t) < Math.abs(nearest.atMs - t)) nearest = event;
      if (event.atMs >= t) break;
    }
    return nearest;
  }

  // Resolve every cue that is due, in chart order. `body` is the current
  // posture: { action, since } with `since` on the same clock as `now`.
  sync(body, now) {
    if (this.status !== 'playing' || !Number.isFinite(now)) return null;
    if (now < this.holdUntil) return null;
    const t = this.time(now), timed = typeof body?.sinceFor === 'function';
    let nearest = null;
    for (const event of this.course.events) {
      if (this.done.has(event.id)) continue;
      if (event.atMs - t > (timed ? OK_MS : 0)) break;
      if (t - event.atMs > OK_MS) return this.judge(event, 'miss', null, t);
      const matches = body && (typeof body.matches === 'function'
        ? body.matches(event.action, now)
        : body.action === event.action);
      if (!matches) continue;
      const raw = timed ? body.sinceFor(event.action) : body.since;
      if (timed && Number.isFinite(raw) && raw < this.inputNotBefore) continue;
      if (timed && Number.isFinite(raw) && this._usedMovement.get(event.action) === raw) continue;
      const at = Number.isFinite(raw) ? this.movementTime(raw) : t;
      const delta = Math.round(at - event.atMs);
      // Keep explicit held-posture adapters working. Real sensor inputs are
      // graded by the movement timestamp and spent on the closest eligible cue.
      if (!timed && delta < -OK_MS) return this.judge(event, 'perfect', 0, t);
      const grade = gradeForDelta(delta);
      // Overlapping same-action windows use the action timestamp. When two
      // distinct postures match, the cue closest to the playhead has priority.
      const closer = !nearest || (event.action === nearest.event.action
        ? Math.abs(delta) < Math.abs(nearest.delta)
        : Math.abs(event.atMs - t) < Math.abs(nearest.event.atMs - t));
      if (grade && closer) {
        nearest = { event, grade, delta, raw };
      }
      if (!timed) break;
    }
    if (!nearest) return null;
    const hit = this.judge(nearest.event, nearest.grade, nearest.delta, t);
    if (timed && Number.isFinite(nearest.raw)) this._usedMovement.set(nearest.event.action, nearest.raw);
    body.consume?.(nearest.event.action, now);
    return hit;
  }

  // Keyboard and replay adapters enter through here. An explicit `since` lets a
  // caller describe a posture that began earlier than this instant.
  input(action, now, { since = -Infinity } = {}) {
    return this.sync({ action, since }, now);
  }

  judge(event, grade, deltaMs, t) {
    this.done.add(event.id);
    const offset = deltaMs === null || deltaMs === 0 ? null : (deltaMs > 0 ? 'late' : 'early');
    const result = { id: event.id, grade, deltaMs, offset, atMs: Math.round(t) };
    this.judgements.push(result);
    this.last = { ...result, lane: event.lane, action: event.action, kind: event.kind };
    this.recent.push(this.last);
    if (this.recent.length > 6) this.recent.shift();
    const totals = this._totals;
    if (grade === 'miss') {
      totals.miss++;
      totals.combo = 0;
    } else {
      totals.combo++;
      totals.maxCombo = Math.max(totals.maxCombo, totals.combo);
      totals[grade]++;
      totals.score += SCORES[grade];
    }
    const gain = grade === 'miss' ? -0.16 : grade === 'perfect' ? 0.11 : grade === 'good' ? 0.06 : 0.03;
    this.energy = clamp01(this.energy + gain);
    return this.last;
  }

  tick(now) {
    if (this.status !== 'playing' || !Number.isFinite(now)) return;
    if (now < this.holdUntil) return;
    const t = this.time(now);
    for (const e of this.course.events) {
      if (!this.done.has(e.id) && (t > e.atMs + EXPIRE_MS || t >= this.course.durationMs)) this.judge(e, 'miss', null, t);
    }
    const drift = now < this.holdUntil ? 0 : (now - (this.lastTickAt ?? now)) / 1000;
    if (now >= this.holdUntil) this.lastTickAt = now;
    if (this.energy > 0) this.energy = clamp01(this.energy - Math.max(0, drift) * 0.05);
    if (t >= this.course.durationMs) { this.elapsedMs = this.course.durationMs; this.status = 'finished'; }
  }

  get combo() { return this._totals.combo; }
  tier(combo) { return combo >= 24 ? 3 : combo >= 12 ? 2 : combo >= 4 ? 1 : 0; }

  snapshot(now) {
    const { combo, perfect, good, ok } = this._totals;
    const n = this.course.events.length;
    const t = this.time(now);
    return {
      status: this.status, elapsedMs: t, ...this._totals,
      tier: this.tier(combo), energy: this.energy, section: this.sectionAt(t),
      accuracy: n ? Math.round((perfect + good * 0.6 + ok * 0.3) / n * 100) : 0,
      progress: t / this.course.durationMs,
      remainingMs: Math.max(0, this.course.durationMs - t),
      next: this.next(now), last: this.last, recent: this.recent.slice(-4),
      events: this.course.events, done: this.done, course: this.course,
    };
  }

  sectionAt(t) {
    const sections = this.course.sections || [];
    for (let i = sections.length - 1; i >= 0; i--) if (t >= sections[i].startMs - 400) return i;
    return 0;
  }

  result() {
    if (this.status !== 'finished') throw new Error('game_not_finished');
    return { courseId: this.course.id, version: this.course.version || 1, timingVersion: TIMING_VERSION, judgements: this.judgements.map(j => ({ ...j })) };
  }
}
