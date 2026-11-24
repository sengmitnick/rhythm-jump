import { LANE_BY_ACTION } from './courses.js';
import { gradeForDelta } from './game.js';

// The pad arm is now determined by the move itself: up = jump, down = squat,
// left / right = dodge. There is no spatial round-robin to apply, but every
// event still carries a lane so renderers and keyboard adapters stay simple.
export function spatialCourses(courses) {
  return courses.map(course => ({
    ...course,
    events: course.events.map(event => ({ ...event, lane: LANE_BY_ACTION.get(event.action) ?? -1 })),
  }));
}

// Keyboard/touch adapters call this; IMU sessions continue through sample().
// This module deliberately has no DOM or browser-only dependencies.
export function inputLane(session, lane) {
  if (session.mode !== 'playing' || !Number.isInteger(lane) || lane < 0 || lane > 3) return null;
  const now = session.clock();
  session.game.tick(now);
  if (session.game.status !== 'playing') return null;
  const state = session.game.snapshot(now);
  let target = null;
  for (const event of state.events) {
    if (event.lane !== lane || state.done.has(event.id)) continue;
    const deltaMs = Math.round(state.elapsedMs - event.atMs);
    const grade = gradeForDelta(deltaMs);
    if (grade && (!target || Math.abs(deltaMs) < Math.abs(target.deltaMs))) target = { event, deltaMs, grade };
  }
  if (!target) return null;
  // Judge this ID rather than the move, so two cues of the same move on
  // neighbouring beats cannot both take the same input.
  const hit = session.game.judge(target.event, target.grade, target.deltaMs, state.elapsedMs);
  try { session.audio?.feedback(hit.grade); } catch { session.message = '声音暂不可用，仍可继续跟拍'; }
  return hit;
}
