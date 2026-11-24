// Perspective stage for the AIUI glasses. The world is the player's room:
// camera at the origin, floor at y = -eye height, +Z ahead. A small amount of
// head yaw/pitch shifts the view. World points are transformed into camera
// space, clipped at the near plane and projected into the 480 x 352 canvas.
//
// The downward stage pitch keeps the floor pads in the lower third
// while looking straight ahead, and still lets the player look down to bring
// them closer to the center of view.
import { wrapAngle } from './head-pose.js';

export const VIEW = Object.freeze({
  width: 480, height: 352, cx: 240, cy: 176,
  // 46° vertical field of view, close to the native panel's usable view.
  focal: 176 / Math.tan((46 * Math.PI / 180) / 2),
  near: 0.14,
});

export const STAGE = Object.freeze({
  eye: 1.3,             // virtual eye height above the floor
  pitch: -0.28,         // neutral downward tilt (about -16°)
  // Routine head movement during a sidestep or landing should leave the
  // judgement pads easy to track. Keep a small parallax on larger head turns.
  headDeadZone: 0.035,  // about 2°
  yawGain: 0.25,
  pitchGain: 0.20,
  yawLimit: 0.065,
  pitchLimit: 0.045,
});

const clean = value => (value === 0 ? 0 : value);

function viewOffset(angle, deadZone, gain, limit) {
  const beyondDeadZone = Math.max(0, Math.abs(angle) - deadZone);
  return clean(Math.sign(angle) * Math.min(beyondDeadZone * gain, limit));
}

export function cameraBasis(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return {
    forward: [clean(sy * cp), clean(sp), clean(cy * cp)],
    right: [clean(cy), 0, clean(-sy)],
    up: [clean(-sp * sy), clean(cp), clean(-sp * cy)],
  };
}

export function createStageCamera(pose = null, tuning = STAGE) {
  // A stale pose keeps its last filtered yaw/pitch so the view freezes instead
  // of snapping back to neutral when the orientation stream goes quiet.
  const usable = pose && (pose.valid !== false || pose.stale === true) &&
    Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch);
  const yaw = usable ? viewOffset(pose.yaw, tuning.headDeadZone, tuning.yawGain, tuning.yawLimit) : 0;
  const pitchOffset = usable ? viewOffset(pose.pitch, tuning.headDeadZone, tuning.pitchGain, tuning.pitchLimit) : 0;
  const pitch = tuning.pitch + pitchOffset;
  return {
    ...VIEW, yaw: wrapAngle(yaw), pitch,
    eye: tuning.eye,
    ...cameraBasis(yaw, pitch),
  };
}

export function toCameraSpace(point, camera) {
  const [x, y, z] = point;
  const { right, up, forward } = camera;
  return [
    x * right[0] + y * right[1] + z * right[2],
    x * up[0] + y * up[1] + z * up[2],
    x * forward[0] + y * forward[1] + z * forward[2],
  ];
}

// Project a camera-space point. Returns null at or behind the near plane.
export function projectCameraPoint(point, camera = VIEW) {
  if (!point || !(point[2] >= camera.near)) return null;
  const scale = camera.focal / point[2];
  const x = camera.cx + point[0] * scale;
  const y = camera.cy - point[1] * scale;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 6000 || Math.abs(y) > 6000) return null;
  return { x, y, scale, depth: point[2] };
}

export function projectWorld(point, camera) {
  return projectCameraPoint(toCameraSpace(point, camera), camera);
}

// Sutherland-Hodgman clip of a camera-space polygon against the near plane.
export function clipNearPlane(points, near) {
  const clipped = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const currentInside = current[2] >= near;
    const nextInside = next[2] >= near;
    if (currentInside) clipped.push(current);
    if (currentInside !== nextInside) {
      const t = (near - current[2]) / (next[2] - current[2]);
      clipped.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        near,
      ]);
    }
  }
  return clipped;
}

export function projectPolygon(worldPoints, camera) {
  if (!Array.isArray(worldPoints) || worldPoints.length < 3) return null;
  const cameraPoints = worldPoints.map(point => toCameraSpace(point, camera));
  const clipped = cameraPoints.some(point => point[2] < camera.near)
    ? clipNearPlane(cameraPoints, camera.near)
    : cameraPoints;
  if (clipped.length < 3) return null;
  const projected = clipped.map(point => projectCameraPoint(point, camera));
  return projected.every(Boolean) ? projected : null;
}

// World point on the floor at a distance ahead, useful for debug overlays.
export function floorPoint(x, z, camera) {
  return [x, -camera.eye, z];
}
