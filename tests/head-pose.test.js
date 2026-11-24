import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeadPose, detectUpAxis, normalizeQuaternion, relativeYawPitch, wrapAngle,
} from '../src/lib/head-pose.js';

function multiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function axisAngle(axis, angle) {
  const [x, y, z] = axis;
  const length = Math.hypot(x, y, z);
  const scale = Math.sin(angle / 2) / length;
  return [x * scale, y * scale, z * scale, Math.cos(angle / 2)];
}
const deg = value => value * Math.PI / 180;

// Device basis rotated so device forward (-Z) is world +X, device up (+Y) is
// world +Z and device right (+X) is world -Y. This is the Android rotation
// vector convention (world Z up) used by the glasses host.
const BASE = multiply(axisAngle([0, 0, 1], -Math.PI / 2), axisAngle([1, 0, 0], Math.PI / 2));

test('quaternion helpers reject invalid readings and keep angles wrapped', () => {
  assert.equal(normalizeQuaternion(null), null);
  assert.equal(normalizeQuaternion([0, 0, 0, 0]), null);
  assert.equal(normalizeQuaternion([NaN, 0, 0, 1]), null);
  assert.deepEqual(normalizeQuaternion([0, 0, 0, 2]), [0, 0, 0, 1]);
  assert.ok(Math.abs(wrapAngle(Math.PI * 2 + 0.2) - 0.2) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-Math.PI * 2 - 0.2) + 0.2) < 1e-9);
});

test('gravity-referenced yaw separates horizontal turning from a tilted calibration', () => {
  const straight = relativeYawPitch(BASE, BASE);
  assert.ok(Math.abs(straight.yaw) < 1e-9 && Math.abs(straight.pitch) < 1e-9);

  const turned = multiply(axisAngle([0, 0, 1], deg(-23)), BASE);
  const horizontal = relativeYawPitch(BASE, turned);
  assert.ok(Math.abs(horizontal.yaw - deg(23)) < 1e-6, 'turning right is positive yaw');
  assert.ok(Math.abs(horizontal.pitch) < 1e-6);

  // A player who calibrated while already looking down and tilting sideways
  // must still get purely horizontal yaw afterwards.
  const tiltedBase = multiply(axisAngle([0, -1, 0], deg(18)), multiply(axisAngle([1, 0, 0], deg(12)), BASE));
  const tiltedTurn = multiply(axisAngle([0, 0, 1], deg(-31)), tiltedBase);
  const tilted = relativeYawPitch(tiltedBase, tiltedTurn);
  assert.ok(Math.abs(tilted.yaw - deg(31)) < 1e-6);
  assert.ok(Math.abs(tilted.pitch) < 1e-6);
});

test('pitch is measured against gravity and supports a Y-up host convention', () => {
  const lookingUp = relativeYawPitch(BASE, multiply(axisAngle([0, -1, 0], deg(21)), BASE));
  assert.ok(Math.abs(lookingUp.pitch - deg(21)) < 1e-6);
  assert.ok(Math.abs(lookingUp.yaw) < 1e-6);

  // Identity base makes device +Y the world up axis, the older host layout.
  assert.deepEqual(detectUpAxis([0, 0, 0, 1]), [0, 1, 0]);
  const yUpTurn = relativeYawPitch([0, 0, 0, 1], axisAngle([0, 1, 0], deg(-17)));
  assert.ok(Math.abs(yUpTurn.yaw - deg(17)) < 1e-6);
  assert.ok(Math.abs(yUpTurn.pitch) < 1e-6);
  assert.equal(detectUpAxis(axisAngle([1, 0, 0], Math.PI / 4)), null, 'a 45° tilted calibration cannot name an axis');
});

test('HeadPose calibrates on demand, smooths, freezes when stale and recovers', () => {
  const pose = new HeadPose({ smoothMs: 20, staleMs: 200 });
  assert.equal(pose.calibrated, false);
  assert.equal(pose.pose(0).valid, false);
  assert.equal(pose.pose(0).calibrated, false);

  // No sample yet: calibration is deferred to the next reading.
  assert.equal(pose.calibrate(0), false);
  pose.sample(BASE, 10);
  assert.equal(pose.calibrated, true, 'the first reading after a pending calibration becomes forward');
  assert.equal(pose.sample([NaN, 0, 0, 1], 20), false);
  assert.equal(pose.pose(20).yaw, 0);

  // Two full turns plus 0.4 rad proves the filter follows the wrapped angle.
  const target = Math.PI * 4 + 0.4;
  pose.sample(multiply(axisAngle([0, 0, 1], target), BASE), 30);
  const first = pose.pose(40);
  assert.ok(first.valid && Math.abs(first.yaw) > 0.1 && Math.abs(first.yaw) < 0.4, 'filter approaches the target');
  let settled = first;
  for (let now = 50; now <= 150; now += 10) settled = pose.pose(now);
  assert.ok(Math.abs(settled.yaw + 0.4) < 0.01, 'smoothed yaw settles on the target (positive Z is a left turn)');

  const stale = pose.pose(240);
  assert.equal(stale.valid, false);
  assert.equal(stale.stale, true);
  assert.ok(Math.abs(stale.yaw - settled.yaw) < 1e-9, 'a quiet sensor holds the last view');

  pose.sample(multiply(axisAngle([0, 0, 1], 0.1), BASE), 250);
  const recovered = pose.pose(260);
  assert.equal(recovered.valid, true);
  assert.equal(recovered.stale, false);

  pose.calibrate(270);
  assert.ok(Math.abs(pose.pose(271).yaw) < 1e-9, 'the latest attitude becomes the new forward');
  pose.reset();
  assert.equal(pose.calibrated, false);
  assert.equal(pose.pose(500).valid, false);
});
