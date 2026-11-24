export const upright = [0, 0, 0, 1];
export const standing = { x: 0, y: 0, z: 9.81 };

export function lateralStep(direction, elapsedMs) {
  if (elapsedMs < 20 || elapsedMs >= 420) return standing;
  const x = direction * (elapsedMs < 220 ? 5 : -5);
  return { ...standing, x };
}

export function warmupSample() {
  return { accel: standing, quaternion: upright };
}

export function tutorialSample(session, now) {
  const lesson = session.tutorial;
  if (session.mode !== 'tutorial' || lesson?.phase !== 'ready') return warmupSample();
  const delta = session.game.time(now) - lesson.phaseAt;
  let accel = standing;
  if (lesson.event.action === 'jump') {
    if (delta >= 60 && delta < 120) accel = { ...standing, z: 20 };
    else if (delta >= 120 && delta < 360) accel = { ...standing, z: 0.5 };
    else if (delta >= 360 && delta < 380) accel = { ...standing, z: 25 };
  } else {
    accel = lateralStep(lesson.event.action === 'dodge-left' ? -1 : 1, delta);
  }
  return { accel, quaternion: upright };
}
