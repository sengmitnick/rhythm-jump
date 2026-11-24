import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE, VIEW, cameraBasis, clipNearPlane, createStageCamera, projectPolygon, projectWorld,
} from '../src/lib/stage-camera.js';

test('stage camera clamps head attitude around a downward neutral pitch', () => {
  const neutral = createStageCamera();
  assert.equal(neutral.yaw, 0);
  assert.equal(neutral.pitch, STAGE.pitch);
  assert.ok(neutral.focal > 400 && neutral.focal < 430);

  const turned = createStageCamera({ yaw: 2, pitch: 0, valid: true });
  assert.equal(turned.yaw, STAGE.yawLimit);
  assert.ok(turned.forward[0] > 0, 'positive yaw looks to the right');
  const up = createStageCamera({ yaw: 0, pitch: 1, valid: true });
  assert.equal(up.pitch, STAGE.pitch + STAGE.pitchLimit);
  const down = createStageCamera({ yaw: 0, pitch: -1, valid: true });
  assert.equal(down.pitch, STAGE.pitch - STAGE.pitchLimit);

  const slight = createStageCamera({ yaw: 0.02, pitch: -0.03, valid: true });
  assert.equal(slight.yaw, 0);
  assert.equal(slight.pitch, STAGE.pitch);

  const invalid = createStageCamera({ yaw: 0.4, pitch: 0.4, valid: false });
  assert.equal(invalid.yaw, 0);
  assert.equal(invalid.pitch, STAGE.pitch);
  const stale = createStageCamera({ yaw: 0.4, pitch: 0, valid: false, stale: true });
  assert.equal(stale.yaw, createStageCamera({ yaw: 0.4, pitch: 0, valid: true }).yaw,
    'a stale pose holds the last view');
  const basis = cameraBasis(0, 0);
  assert.deepEqual(basis.forward, [0, 0, 1]);
  assert.deepEqual(basis.right, [1, 0, 0]);
  assert.deepEqual(basis.up, [0, 1, 0]);
});

test('projection keeps the floor pads on screen and culls points behind the camera', () => {
  const camera = createStageCamera();
  const pad = projectWorld([0, -STAGE.eye, 2.4], camera);
  assert.ok(pad && pad.x > 200 && pad.x < 280);
  assert.ok(pad.y > 240 && pad.y < 300);
  const horizon = projectWorld([0, 0, 50], camera);
  assert.ok(horizon && horizon.y > 40 && horizon.y < 90);
  assert.equal(projectWorld([0, 0, -1], camera), null);
  assert.equal(projectWorld([0, 0, VIEW.near * 0.5], camera), null);

  const wall = screenOf(projectPolygon([[-1, -1, 3], [1, -1, 3], [1, 1, 3], [-1, 1, 3]], camera));
  assert.equal(wall.length, 4);
  assert.ok(wall.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test('near-plane clipping keeps polygons that straddle the camera', () => {
  const camera = createStageCamera();
  const straddling = [[-1, 0, 0.05], [1, 0, 0.05], [1, 0, 2], [-1, 0, 2]];
  const projected = projectPolygon(straddling, camera);
  assert.ok(projected && projected.length >= 3);
  assert.ok(projected.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  const clipped = clipNearPlane([
    [-1, 0, 0.05], [1, 0, 0.05], [1, 0, 2], [-1, 0, 2],
  ], VIEW.near);
  assert.ok(clipped.every(point => point[2] >= VIEW.near));
  assert.equal(clipNearPlane([[-1, 0, -1], [1, 0, -1]], VIEW.near).length, 0);
});

function screenOf(points) {
  return points.map(point => ({
    x: point.x, y: point.y,
  }));
}
