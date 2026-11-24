import { render as renderBase, GLASSES_INK as C } from './render.js';
import { DIRECTIONS, LANES, LANE_BY_ACTION, ENABLE_DUCK } from './courses.js';
import { PERFECT_MS, GOOD_MS, OK_MS } from './game.js';
import { menuTargets } from './menu-navigation.js';
import { TUTORIAL_DEMO_MS } from './tutorial.js';
import {
  STAGE, createStageCamera, projectWorld, projectPolygon,
} from './stage-camera.js';

// Native counterpart of the approved web stage, rebuilt as a 3DoF room.
// Targets approach a shared judgement line in three perspective lanes.
// The stage has bounded head parallax; the score and metronome stay fixed.
const W = 480, H = 352;
const FLOOR = -1.3;
const PAD_Z = 3.05, PAD_HALF_X = 0.27, PAD_HALF_Z = 0.32;
const PAD_Y = FLOOR + 0.045;
const LANE_SPACING = 0.68;
const PADS = [
  { x: 0, y: PAD_Y, z: PAD_Z },
  { x: 0, y: PAD_Y, z: 2.12 },
  { x: -LANE_SPACING, y: PAD_Y, z: PAD_Z },
  { x: LANE_SPACING, y: PAD_Y, z: PAD_Z },
];
const DUCK_LANE = LANE_BY_ACTION.get('duck');
const LIVE_LANES = ENABLE_DUCK ? [0, 1, 2, 3] : [0, 2, 3];
const laneEnabled = lane => !!PADS[lane] && (ENABLE_DUCK || lane !== DUCK_LANE);
const actionEnabled = action => ENABLE_DUCK || action !== 'duck';
const ACTION_PROMPT = { 'dodge-left': '左跨', jump: '起跳', 'dodge-right': '右跨', duck: '下蹲' };
const NOTE_SIZE = 0.55, NOTE_DEPTH = 0.11;
const FAR_Z = 9.2, HORIZON_MS = 3000;
const NOTE_SPAWN_Y = 0.18;
const NOTE_LIFT = 0.20;
const JUDGEMENT_SPEED = 0.0015;
const JUDGEMENT_ZONES = [
  { window: PERFECT_MS, halfWidth: 0.21, width: 1.3, color: C.frame },
  { window: GOOD_MS, halfWidth: 0.26, width: 1, color: C.guide },
  { window: OK_MS, halfWidth: 0.32, width: 0.8, color: C.guide },
];
const HIT_STYLES = {
  perfect: { color: C.bright, points: 1000, duration: 300, spread: 0.27, depth: 0.22, width: 3, sparks: 6, radius: 31, length: 13, sparkWidth: 2.3 },
  good: { color: C.text, points: 500, duration: 210, spread: 0.13, depth: 0.10, width: 2.05, sparks: 4, radius: 18, length: 8, sparkWidth: 1.4 },
  ok: { color: C.secondary, points: 250, duration: 180, spread: 0.09, depth: 0.08, width: 1.65, sparks: 2, radius: 13, length: 6, sparkWidth: 1.1 },
};
const OBSTACLE_Z = 1.15, OBSTACLE_SPEED = 0.004;
const TUNNEL_FAR = 11, TUNNEL_NEAR = 1.6;

function strokePath(c, color, width, path) {
  c.strokeStyle = color;
  c.lineWidth = width;
  if (path) c.stroke(path);
  else c.stroke();
}
function addPolyline(c, points) {
  c.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) c.lineTo(points[i][0], points[i][1]);
}
function outline(c, points, color, width = 1) {
  c.beginPath();
  addPolyline(c, points);
  c.closePath();
  strokePath(c, color, width);
}
function line(c, points, color, width = 1) {
  c.beginPath();
  addPolyline(c, points);
  strokePath(c, color, width);
}
function text(c, value, x, y, size = 10, color = C.text, align = 'left', bold = false, maxWidth) {
  c.font = `${bold || size >= 14 ? 'bold ' : ''}${size}px sans-serif`;
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  if (maxWidth) c.fillText(String(value), x, y, maxWidth);
  else c.fillText(String(value), x, y);
}
function rounded(c, x, y, w, h, radius, fill, stroke, width = 0.8) {
  // arc-based paths also work on deployed hosts predating roundRect support.
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y);
  c.arc(x + w - r, y + r, r, -Math.PI / 2, 0); c.lineTo(x + w, y + h - r);
  c.arc(x + w - r, y + h - r, r, 0, Math.PI / 2); c.lineTo(x + r, y + h);
  c.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI); c.lineTo(x, y + r);
  c.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5); c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}
function clearBlack(c) {
  // An opaque black paint replaces the previous frame and clears the optics.
  c.globalAlpha = 1;
  c.fillStyle = C.black;
  c.fillRect(0, 0, W, H);
}
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
function screenPoints(points) {
  return points ? points.map(point => [point.x, point.y]) : null;
}
function screenPolygon(c, worldPoints, camera) {
  return screenPoints(projectPolygon(worldPoints, camera));
}
function fillPolygon(c, points, color) {
  if (!points) return false;
  c.beginPath();
  addPolyline(c, points);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  return true;
}

// --------------------------------------------------------------- tunnel
// Floor rails and beat lines share the same stage projection as the targets,
// which is the main source of parallax for the 3DoF room.
const FLOOR_RAILS = [-2.4, -LANE_SPACING, 0, LANE_SPACING, 2.4].map(x => [x, FLOOR]);
const CORRIDOR_RAILS = [[-2.4, FLOOR], [-2.4, 1], [2.4, FLOOR], [2.4, 1]];
let railCache;

function projectRails(rails, camera) {
  return rails.map(([x, y]) => [
    projectWorld([x, y, TUNNEL_NEAR], camera),
    projectWorld([x, y, TUNNEL_FAR], camera),
  ]);
}
function traceRails(path, rails) {
  for (const [near, far] of rails) {
    if (near && far) { path.moveTo(near.x, near.y); path.lineTo(far.x, far.y); }
  }
}
function drawTunnelRails(c, camera) {
  const sameView = railCache?.yaw === camera.yaw && railCache?.pitch === camera.pitch;
  if (!sameView) {
    railCache = {
      yaw: camera.yaw, pitch: camera.pitch,
      rails: [projectRails(FLOOR_RAILS, camera), projectRails(CORRIDOR_RAILS, camera)],
      paths: undefined,
    };
  } else if (railCache.paths === undefined) {
    // Only prepare reusable native paths once the exact projected view repeats.
    // A changing pose uses the immediate Canvas path and keeps full parallax.
    railCache.paths = null;
    if (typeof Path2D === 'function') {
      try {
        railCache.paths = railCache.rails.map(rails => {
          const path = new Path2D();
          traceRails(path, rails);
          return path;
        });
      } catch {
        // The same projected rails can still be drawn on the Canvas context.
      }
    }
  }
  // Paint the groups separately so overlapping rails retain their opacity.
  for (let index = 0; index < railCache.rails.length; index++) {
    const path = railCache.paths?.[index];
    if (!path) {
      c.beginPath();
      traceRails(c, railCache.rails[index]);
    }
    strokePath(c, C.trace, 0.8, path);
  }
}

function tunnel(c, camera, t, bpm) {
  const beatMs = 60000 / bpm;
  const phase = ((t % beatMs) + beatMs) % beatMs / beatMs;
  drawTunnelRails(c, camera);

  // Beat pulses travel along the floor toward the pads and keep the corridor
  // readable when the player looks down at their feet.
  const ribs = tunnelRibs;
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const p = ((i / 4 + phase / 4) % 1 + 1) % 1;
    const z = TUNNEL_NEAR + (1 - p) * (TUNNEL_FAR - TUNNEL_NEAR);
    if (z > TUNNEL_FAR) continue;
    const left = projectWorld([-2.4, FLOOR, z], camera);
    const right = projectWorld([2.4, FLOOR, z], camera);
    const rib = ribs[i];
    rib.z = z; rib.left = left; rib.right = right;
    if (left && right) { c.moveTo(left.x, left.y); c.lineTo(right.x, right.y); }
  }
  strokePath(c, C.guide, 0.9);

  // Short side ticks mark distance without looking like an obstacle wall.
  c.beginPath();
  for (const { z, left, right } of ribs) {
    const leftTop = projectWorld([-2.4, FLOOR + 0.28, z], camera);
    const rightTop = projectWorld([2.4, FLOOR + 0.28, z], camera);
    if (left && leftTop) { c.moveTo(left.x, left.y); c.lineTo(leftTop.x, leftTop.y); }
    if (right && rightTop) { c.moveTo(right.x, right.y); c.lineTo(rightTop.x, rightTop.y); }
  }
  strokePath(c, C.trace, 0.8);
}

const tunnelRibs = Array.from({ length: 4 }, () => ({ z: 0, left: null, right: null }));

// ----------------------------------------------------------- pads / notes
// Reuse the same silhouette on the floor and on the approaching note. The two
// axes of its plane come from the stage, so head motion changes its perspective.
const ARROW_UP = [[0, 0.60], [-0.46, 0.03], [-0.18, 0.03], [-0.18, -0.52],
  [0.18, -0.52], [0.18, 0.03], [0.46, 0.03]];
const ARROWS = {
  up: ARROW_UP,
  down: ARROW_UP.map(([x, y]) => [-x, -y]),
  left: ARROW_UP.map(([x, y]) => [-y, x]),
  right: ARROW_UP.map(([x, y]) => [y, -x]),
};

function padCorners(pad, halfX = PAD_HALF_X, halfZ = PAD_HALF_Z) {
  return [
    [pad.x - halfX, pad.y, pad.z - halfZ],
    [pad.x + halfX, pad.y, pad.z - halfZ],
    [pad.x + halfX, pad.y, pad.z + halfZ],
    [pad.x - halfX, pad.y, pad.z + halfZ],
  ];
}
const PAD_CORNERS = PADS.map(pad => padCorners(pad));
const ZONE_CORNERS = PADS.map(pad => JUDGEMENT_ZONES.map(zone =>
  padCorners(pad, zone.halfWidth, zone.window * JUDGEMENT_SPEED)));
const PAD_ARROWS = PADS.map((pad, lane) => ARROWS[LANES[lane].dir].map(([x, depth]) => [
  pad.x + x * 0.42, pad.y + 0.008, pad.z + depth * 0.48,
]));

export function padScreens(pose = null) {
  const camera = createStageCamera(pose);
  return PADS.map((pad, lane) => laneEnabled(lane) ? projectWorld([pad.x, pad.y, pad.z], camera) : null);
}

function pads(c, camera, activeLane, focusedLane) {
  const railZ = PAD_Z - PAD_HALF_Z;
  const railLeft = projectWorld([-LANE_SPACING - 0.44, PAD_Y, railZ], camera);
  const railRight = projectWorld([LANE_SPACING + 0.44, PAD_Y, railZ], camera);
  if (railLeft && railRight) line(c, [[railLeft.x, railLeft.y], [railRight.x, railRight.y]], C.guide, 1.2);

  const outlines = padOutlines;
  for (let index = 0; index < LIVE_LANES.length; index++) {
    const lane = LIVE_LANES[index];
    outlines[index] = lane === focusedLane ? null : screenPolygon(c, PAD_CORNERS[lane], camera);
  }
  c.beginPath();
  for (const corners of outlines) {
    if (corners) { addPolyline(c, corners); c.closePath(); }
  }
  c.fillStyle = C.black;
  c.fill();
  strokePath(c, C.frame, 1);
  const active = focusedLane === undefined ? outlines[LIVE_LANES.indexOf(activeLane)] : null;
  if (active) outline(c, active, C.text, 1.6);

  c.beginPath();
  for (const lane of LIVE_LANES) {
    if (lane === focusedLane) continue;
    const arrow = screenPolygon(c, PAD_ARROWS[lane], camera);
    if (arrow) { addPolyline(c, arrow); c.closePath(); }
  }
  strokePath(c, C.frame, 0.85);
}

const padOutlines = new Array(LIVE_LANES.length);

function judgementZones(c, event, delta, camera) {
  const active = JUDGEMENT_ZONES.findIndex(zone => Math.abs(delta) <= zone.window);
  for (let index = JUDGEMENT_ZONES.length - 1; index >= 0; index--) {
    const zone = JUDGEMENT_ZONES[index];
    const corners = screenPolygon(c, ZONE_CORNERS[event.lane][index], camera);
    if (!corners) continue;
    outline(c, corners, index === active ? C.bright : zone.color, index === active ? 2.1 : zone.width);
  }
}

function judgementLabelY(pad, camera) {
  const near = projectWorld([pad.x, pad.y, pad.z - OK_MS * JUDGEMENT_SPEED], camera);
  return near ? Math.min(278, Math.max(44, near.y + 18)) : null;
}

function judgementCue(c, event, delta, camera) {
  const pad = PADS[event.lane];
  const point = projectWorld([pad.x, pad.y, pad.z], camera);
  if (!point) return;
  const inWindow = Math.abs(delta) <= OK_MS;
  const color = inWindow ? C.bright : C.text;
  // A short bar marks the approaching arrow's exact depth on the timing pad.
  const z = noteDepth(delta, event.lane);
  const left = projectWorld([pad.x - 0.12, pad.y, z], camera);
  const right = projectWorld([pad.x + 0.12, pad.y, z], camera);
  if (left && right) line(c, [[left.x, left.y], [right.x, right.y]], color, 2.6);

  const y = judgementLabelY(pad, camera);
  if (y !== null) text(c, ACTION_PROMPT[event.action], Math.max(38, Math.min(W - 38, point.x)), y, 17, color, 'center', true);
}

function noteDepth(delta, lane) {
  const padZ = PADS[lane].z;
  if (delta <= OK_MS) return padZ + Math.max(-OK_MS, delta) * JUDGEMENT_SPEED;
  const entryZ = padZ + OK_MS * JUDGEMENT_SPEED;
  return entryZ + (FAR_Z - entryZ) * clamp01((delta - OK_MS) / (HORIZON_MS - OK_MS));
}

function notePosition(lane, delta) {
  const progress = clamp01(1 - delta / HORIZON_MS);
  const pad = PADS[lane];
  const y = NOTE_SPAWN_Y + (pad.y + NOTE_LIFT - NOTE_SPAWN_Y) * progress;
  return [pad.x, y, noteDepth(delta, lane)];
}

export function noteScreen(event, elapsedMs, pose = null) {
  if (!laneEnabled(event.lane) || !actionEnabled(event.action)) return null;
  return projectWorld(notePosition(event.lane, event.atMs - elapsedMs), createStageCamera(pose));
}

export function displayElapsedMs(state, offsetMs = 0) {
  const elapsed = Number.isFinite(state?.elapsedMs) ? state.elapsedMs : 0;
  const offset = Number.isFinite(offsetMs) ? Math.max(-250, Math.min(250, offsetMs)) : 0;
  return Math.max(0, Math.min(state?.course?.durationMs ?? Infinity, elapsed + offset));
}

function note(c, event, delta, camera, focused) {
  const [x, y, z] = notePosition(event.lane, delta);
  const point = projectWorld([x, y, z], camera);
  if (!point) return;
  const glyph = ARROWS[DIRECTIONS[event.action] || LANES[event.lane].dir];
  const frontWorld = glyph.map(([u, v]) => [x + u * NOTE_SIZE, y + v * NOTE_SIZE, z + v * 0.18]);
  const front = screenPolygon(c, frontWorld, camera);
  if (!front) return;
  // Far cues only need their silhouette. Draw the side edge once it has
  // visible width, and keep the forward face the strongest cue.
  if (point.scale >= 62) {
    const backWorld = frontWorld.map(([px, py, pz]) => [px, py - 0.035, pz + NOTE_DEPTH]);
    const back = screenPolygon(c, backWorld, camera);
    if (front.length === glyph.length && back?.length === glyph.length) {
      c.beginPath();
      addPolyline(c, back); c.closePath();
      for (const index of [0, 3, 4]) {
        c.moveTo(front[index][0], front[index][1]); c.lineTo(back[index][0], back[index][1]);
      }
      strokePath(c, C.frame, 0.85);
    }
  }
  c.beginPath();
  addPolyline(c, front); c.closePath();
  c.fillStyle = C.black; c.fill();
  const color = focused ? C.bright : C.secondary;
  strokePath(c, color, Math.max(1.05, Math.min(focused ? 2.8 : 1.6, point.scale * 0.020)));
}

// --------------------------------------------------------------- obstacles
// Walls and beams grow as they approach and slide past the camera at cue time.
// Walls are black occluders immediately; a beam stays outlined until ducking
// range so it does not read as a floating black billboard over the chart.
function obstacleBox(c, camera, faces, proximity, solid) {
  // A beam stays an outlined frame while it approaches, then turns into a
  // solid black occluder only at ducking distance. Filling it the whole way
  // would read as a floating black billboard over the chart.
  if (solid) {
    for (const face of faces) {
      const projected = screenPolygon(c, face, camera);
      if (projected) fillPolygon(c, projected, C.black);
    }
  }
  const front = screenPolygon(c, faces[0], camera);
  if (!front) return;
  outline(c, front, C.bright, 1 + 1.4 * proximity);
  for (const face of faces.slice(1)) {
    const projected = screenPolygon(c, face, camera);
    if (projected) outline(c, projected, C.frame, 0.9);
  }
}

function obstacleDepth(delta) {
  return OBSTACLE_Z + Math.max(-0.30, delta * OBSTACLE_SPEED);
}

function obstacle(c, event, delta, camera) {
  if (delta < -320) return;
  const z = obstacleDepth(delta);
  if (z < 0.35) return;
  const proximity = clamp01(1 - (z - 0.9) / 3.0);
  const zNear = z - 0.17, zFar = z + 0.17;
  if (event.action === 'jump') {
    // A low bar is passed by leaving the floor, so it is drawn low and thin.
    const x0 = -1.7, x1 = 1.7, y0 = FLOOR, y1 = FLOOR + 0.44;
    const solid = proximity > 0.55;
    obstacleBox(c, camera, [
      [[x0, y0, zNear], [x1, y0, zNear], [x1, y1, zNear], [x0, y1, zNear]],
      [[x0, y1, zNear], [x1, y1, zNear], [x1, y1, zFar], [x0, y1, zFar]],
    ], proximity, solid);
    c.beginPath();
    const mid = (y0 + y1) / 2;
    for (let i = 0; i < 6; i++) {
      const left = projectWorld([x0 + (x1 - x0) * (i / 6), mid, zNear], camera);
      const right = projectWorld([x0 + (x1 - x0) * ((i + 0.5) / 6), y1, zNear], camera);
      if (left && right) { c.moveTo(left.x, left.y); c.lineTo(right.x, right.y); }
    }
    strokePath(c, C.trace, 0.9);
    return;
  }
  if (event.action === 'duck') {
    const x0 = -1.8, x1 = 1.8, y0 = -0.55, y1 = 1.0;
    const solid = proximity > 0.55;
    obstacleBox(c, camera, [
      [[x0, y0, zNear], [x1, y0, zNear], [x1, y1, zNear], [x0, y1, zNear]],
      [[x0, y0, zNear], [x1, y0, zNear], [x1, y0, zFar], [x0, y0, zFar]],
    ], proximity, solid);
    // A thin lip under the beam face gives the bottom edge visible thickness.
    const lipLeft = projectWorld([x0, y0 + 0.06, zNear], camera);
    const lipRight = projectWorld([x1, y0 + 0.06, zNear], camera);
    if (lipLeft && lipRight) line(c, [[lipLeft.x, lipLeft.y], [lipRight.x, lipRight.y]], C.text, 1.1);
    // Sparse diagonals keep the beam surface visible on the see-through
    // display, where black paint erases virtual content instead of emitting.
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const t = 0.12 + i * 0.24;
      const a = projectWorld([x0 + (x1 - x0) * t, y0, zNear], camera);
      const b = projectWorld([x0 + (x1 - x0) * (t + 0.12), y1, zNear], camera);
      if (a && b) { c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); }
    }
    strokePath(c, C.trace, 0.9);
    return;
  }
  // dodge-left means the wall occupies the right half and leaves the left gap.
  const right = event.action === 'dodge-left';
  const x0 = right ? 0.08 : -2.0, x1 = right ? 2.0 : -0.08;
  const y0 = FLOOR, y1 = 1.15;
  const front = screenPolygon(c, [
    [x0, y0, zNear], [x1, y0, zNear], [x1, y1, zNear], [x0, y1, zNear],
  ], camera);
  if (!front) return;
  fillPolygon(c, front, C.black);
  outline(c, front, C.bright, 1 + 1.4 * proximity);
  // Sparse diagonals read as the occupied part of the passage without fill.
  c.beginPath();
  for (let i = 0; i < 3; i++) {
    const t = 0.18 + i * 0.3;
    const bottom = projectWorld([x0 + (x1 - x0) * t, y0, zNear], camera);
    const top = projectWorld([x0 + (x1 - x0) * (t + 0.16), y1, zNear], camera);
    if (bottom && top) { c.moveTo(bottom.x, bottom.y); c.lineTo(top.x, top.y); }
  }
  strokePath(c, C.trace, 0.9);
}

// Reused per-frame scratch list. A beam at cue time can be nearer than a note
// that arrives later, so draw order follows current depth, not chart order.
const visibleEvents = [];
const visibleEventPool = [];

function queueVisibleEvent(event, delta, z) {
  const index = visibleEvents.length;
  const item = visibleEventPool[index] || (visibleEventPool[index] = {});
  item.event = event; item.delta = delta; item.z = z;
  visibleEvents.push(item);
}

function events(c, state, t, camera) {
  visibleEvents.length = 0;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i], delta = event.atMs - t;
    if (delta > HORIZON_MS) continue;
    if (delta < -Math.max(320, OK_MS)) break;
    if (state.done.has(event.id) || !actionEnabled(event.action)) continue;
    if (event.kind === 'wall') {
      const z = obstacleDepth(delta);
      if (z >= 0.35) queueVisibleEvent(event, delta, z);
    } else if (laneEnabled(event.lane)) {
      queueVisibleEvent(event, delta, noteDepth(delta, event.lane));
    }
  }
  visibleEvents.sort((a, b) => b.z - a.z);
  for (const item of visibleEvents) {
    if (item.event.kind === 'wall') obstacle(c, item.event, item.delta, camera);
    else note(c, item.event, item.delta, camera, item.event.id === state.next?.id);
  }
}

// ------------------------------------------------------------------- HUD
function beatTicks(c, t, bpm) {
  const beatMs = 60000 / bpm;
  const beat = Math.floor(t / beatMs) % 4;
  line(c, [[186, 332], [294, 332]], C.trace, 0.8);
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    if (i === beat) continue;
    const x = 195 + i * 30;
    c.moveTo(x, 332); c.lineTo(x, 328);
  }
  strokePath(c, C.guide, 1.1);
  const x = 195 + beat * 30;
  line(c, [[x, 332], [x, 324]], C.bright, 2.2);
}
function impact(c, pad, camera, point, age, hit) {
  if (age >= hit.duration) return;
  const p = age / hit.duration;
  const travel = 1 - (1 - p) ** 2;
  const halfX = PAD_HALF_X + travel * hit.spread;
  const halfZ = PAD_HALF_Z + travel * hit.depth;
  const corners = screenPolygon(c, padCorners(pad, halfX, halfZ), camera);
  c.save();
  c.globalAlpha = 1 - p;
  if (corners) outline(c, corners, hit.color, hit.width - p);
  const radius = (13 + travel * hit.radius) * Math.min(1.3, point.scale / 130);
  const length = hit.length * (1 - p);
  c.beginPath();
  for (let index = 0; index < hit.sparks; index++) {
    const angle = (index + 0.5) * 2 * Math.PI / hit.sparks;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    c.moveTo(point.x + dx * radius, point.y + dy * radius * 0.68);
    c.lineTo(point.x + dx * (radius + length), point.y + dy * (radius + length) * 0.68);
  }
  strokePath(c, hit.color, hit.sparkWidth);
  c.restore();
}

function feedback(c, state, t, camera) {
  const last = state.last;
  if (!last || !laneEnabled(last.lane) || !actionEnabled(last.action)) return;
  const age = t - last.atMs;
  const perfect = last.grade === 'perfect';
  const hit = HIT_STYLES[last.grade];
  const duration = hit ? 450 : 310;
  if (age < 0 || age >= duration) return;

  const pad = PADS[last.lane];
  const point = projectWorld([pad.x, pad.y + NOTE_LIFT, pad.z], camera);
  if (!point || point.x < 0 || point.x > W || point.y < 22 || point.y > H) return;
  const x = Math.max(48, Math.min(W - 48, point.x));
  // The next arrow approaches above the rail. Reserve the first row below it
  // for the incoming prompt and the second row for the previous judgement.
  const actionY = judgementLabelY(pad, camera) ?? point.y;
  const y = actionY + 21;
  const color = hit?.color ?? C.secondary;
  if (hit) impact(c, pad, camera, point, age, hit);

  c.save();
  c.globalAlpha = clamp01((duration - age) / 150);
  const size = perfect ? 15 + 3 * clamp01(1 - age / 150) : hit ? 14 : 12;
  text(c, last.grade.toUpperCase(), x, y, Math.round(size), color, 'center', true);
  if (hit) {
    const timing = !perfect && last.offset ? (last.offset === 'late' ? ' · 稍晚' : ' · 稍早') : '';
    text(c, `+${hit.points}${timing}`, x, y + 14, 11, color, 'center', true);
  }
  c.restore();
}

function perfMeter(c, perf) {
  if (!perf?.text || !Number.isFinite(perf.fps) || !Number.isFinite(perf.peakMs)) return;
  const label = `${Math.round(perf.fps)} FPS · 峰值 ${Math.round(perf.peakMs)}ms`;
  text(c, label, 465, 328, 9, perf.peakMs > 60 || perf.fps < 18 ? C.text : C.secondary, 'right');
}
function hud(c, state) {
  text(c, String(state.combo).padStart(2, '0'), 15, 34, 25, state.combo >= 12 ? C.bright : C.text);
  text(c, 'COMBO', 53, 32, 8, C.secondary);
  line(c, [[137, 21], [357, 21]], C.guide);
  line(c, [[137, 21], [137 + Math.max(2, state.progress * 220), 21]], C.text, 1.5);
  const sections = state.course.sections;
  if (sections?.length) {
    c.beginPath();
    for (const section of sections) {
      const x = 137 + Math.min(1, section.startMs / state.course.durationMs) * 220;
      c.moveTo(x, 18);
      c.lineTo(x, 24);
    }
    strokePath(c, C.frame, 0.8);
  }
  text(c, sections?.[state.section]?.label || '', 247, 37, 9, C.secondary, 'center');
  const seconds = Math.ceil(state.remainingMs / 1000);
  text(c, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, 464, 33, 18, C.text, 'right');
  // String formatting avoids depending on optional Intl support in the host.
  text(c, String(state.score), 463, 69, 19, C.text, 'right');
  text(c, 'SCORE', 463, 82, 8, C.secondary, 'right');
  const energyHeight = Math.max(2, (state.energy || 0) * 80);
  line(c, [[465, 137], [465, 217]], C.guide);
  line(c, [[465, 217 - energyHeight], [465, 217]], state.energy > 0.6 ? C.bright : C.text, 1.5);
}
function motionDebugHud(c, body) {
  const { motionPhase: phase, motionDirection: direction } = body || {};
  const moving = phase === 'moving', settling = phase === 'settling', ready = phase === 'ready';
  const side = direction === 'dodge-left' ? -1 : direction === 'dodge-right' ? 1 : 0;
  const showDirection = side && (moving || settling || ready);
  const status = moving ? (showDirection ? '移动中' : '检测侧移中')
    : settling ? '回稳中' : ready ? (showDirection ? '已回稳' : '侧移就绪') : '动作信号不可用';
  const color = moving && showDirection ? C.text : C.secondary;
  const x = 24, y = 329;
  if (showDirection) {
    const tip = x + side * 6;
    line(c, [[x - side * 6, y], [tip, y], [tip - side * 4, y - 4]], color, 1.2);
    line(c, [[tip, y], [tip - side * 4, y + 4]], color, 1.2);
  } else if (ready) {
    c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); strokePath(c, C.secondary, 1.1);
  } else {
    line(c, [[x - 5, y], [x + 5, y]], C.guide, 1);
  }
  const label = showDirection ? `${side < 0 ? '左移' : '右移'} · ${status}` : status;
  text(c, label, 36, 333, 11, color);
}

// The aiming guide stays fixed while the IMU checks or captures the neutral pose.
function calibrationStage(c, model) {
  const { still, hint, step } = model.stand || {};
  const checking = step === 'checking';
  const detail = hint || (checking ? '正在检查当前姿态' : '保持头部不动');
  text(c, checking ? '检测姿态' : '姿态校准', 240, 92, 26, C.text, 'center');
  text(c, '正视前方站稳', 240, 119, 15, C.secondary, 'center');

  c.beginPath(); c.arc(240, 176, 20, 0, Math.PI * 2); strokePath(c, C.guide, 0.85);
  c.beginPath();
  c.moveTo(213, 176); c.lineTo(231, 176);
  c.moveTo(249, 176); c.lineTo(267, 176);
  c.moveTo(240, 149); c.lineTo(240, 167);
  c.moveTo(240, 185); c.lineTo(240, 203);
  strokePath(c, C.frame, 1.1);
  c.beginPath(); c.arc(240, 176, 2.2, 0, Math.PI * 2); c.fillStyle = C.bright; c.fill();

  const barX = 154, barW = 172, barY = 235;
  const progress = Number.isFinite(still) ? clamp01(still) : 0;
  line(c, [[barX, barY], [barX + barW, barY]], C.guide, 1);
  if (progress > 0) line(c, [[barX, barY], [barX + barW * progress, barY]], C.text, 2);
  text(c, detail, 240, 260, 13, C.text, 'center');
  if (model.message && model.message !== detail) text(c, model.message, 240, 281, 11, C.secondary, 'center');
  text(c, '返回键回到主菜单', 240, 342, 11, C.secondary, 'center');
}

function stage(c, state, t, bpm, camera, body) {
  tunnel(c, camera, t, bpm);
  const next = state.next;
  const leadMs = Math.max(OK_MS, Math.min(680, 1.35 * 60000 / bpm));
  const delta = next ? next.atMs - t : Infinity;
  const ready = delta <= leadMs && delta >= -OK_MS && laneEnabled(next.lane) &&
    actionEnabled(next.action) && !state.done.has(next.id);
  const activeLane = LANE_BY_ACTION.get(body?.action);
  pads(c, camera, activeLane, ready ? next.lane : undefined);
  if (ready) judgementZones(c, next, delta, camera);
  events(c, state, t, camera);
  if (ready) judgementCue(c, next, delta, camera);
  beatTicks(c, t, bpm);
}

const MENU_CAMERA = { ...STAGE, pitch: -0.07, yawGain: 0.17, pitchGain: 0.13, yawLimit: 0.045, pitchLimit: 0.025 };
const MENU_MODULES = {
  leaderboard: { title: '排行榜', detail: '按曲目查看' },
  tutorial: { title: '新手教程', detail: '左跨 · 右跨 · 起跳' },
};

function menuRoom(c, cursor) {
  const pose = cursor ? { yaw: (cursor.x - 298) / 405, pitch: (175 - cursor.y) / 365 } : null;
  const camera = createStageCamera(pose, MENU_CAMERA);
  c.beginPath();
  const rail = (a, b) => {
    const start = projectWorld(a, camera), end = projectWorld(b, camera);
    if (start && end) { c.moveTo(start.x, start.y); c.lineTo(end.x, end.y); }
  };
  for (const x of [-3.1, -1.55, 0, 1.55, 3.1]) rail([x, FLOOR, 2.4], [x, FLOOR, 7.5]);
  for (const z of [3.2, 4.4, 6, 7.5]) rail([-3.1, FLOOR, z], [3.1, FLOOR, z]);
  for (const x of [-3.1, 3.1]) rail([x, FLOOR, 7.5], [x, 1.2, 7.5]);
  strokePath(c, C.trace, 0.8);
}

function menuPanel(c, { x, y, w, h }, active, selected) {
  const bevel = 9;
  const front = [
    [x, y + bevel], [x + bevel, y], [x + w, y],
    [x + w, y + h - bevel], [x + w - bevel, y + h], [x, y + h],
  ];
  // Keep the interactive front fixed while the room behind it follows the head.
  const depth = active ? 5 : 3;
  const right = front.slice(2, 5);
  outline(c, [...right, ...right.reverse().map(([px, py]) => [px + depth, py - depth])], active ? C.frame : C.trace, 0.8);
  fillPolygon(c, front, C.black);
  outline(c, front, active ? C.bright : selected ? C.frame : C.guide, active ? 1.6 : 0.85);
  if (active || selected) line(c, [[x + 6, y + 15], [x + 6, y + h - 7]], active ? C.bright : C.secondary, 2.2);
}

function menuSong(c, target, song, active, selected, menu) {
  const { x, y, w } = target;
  menuPanel(c, target, active, selected);
  const metadata = [];
  if (Number.isFinite(song.bpm)) metadata.push(`${song.bpm} BPM`);
  if (Number.isFinite(song.durationMs)) {
    const seconds = Math.round(song.durationMs / 1000);
    metadata.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
  }
  if (song.artist || song.genre) metadata.push(song.artist || song.genre);
  text(c, song.title, x + 17, y + 22, 17, active ? C.bright : C.text, 'left', true, w - 98);
  text(c, metadata.join('  ·  '), x + 17, y + 37, 10, active ? C.text : C.secondary, 'left', false, w - 90);
  if (active && menu.previewPlaying) {
    const end = x + w - 13, start = end - 54;
    const progress = clamp01(menu.previewProgress || 0);
    text(c, '试听中', end, y + 23, 10, C.bright, 'right');
    line(c, [[start, y + 34], [end, y + 34]], C.guide, 1.2);
    if (progress > 0) line(c, [[start, y + 34], [start + (end - start) * progress, y + 34]], C.bright, 1.7);
  } else {
    // The right edge is the direction of travel into the course.
    line(c, [[x + w - 24, y + 19], [x + w - 19, y + 24], [x + w - 24, y + 29]], active ? C.bright : C.guide, 1.2);
  }
}

function menuModule(c, target, active) {
  const { x, y, w, focus } = target;
  const { title, detail } = MENU_MODULES[focus];
  const iconColor = active ? C.bright : C.frame;
  menuPanel(c, target, active, false);
  text(c, title, x + 16, y + 27, 17, active ? C.bright : C.text, 'left', false, w - 54);
  text(c, detail, x + 16, y + 45, 10, active ? C.text : C.secondary, 'left', false, w - 54);
  const ix = x + w - 23, iy = y + 26;
  if (focus === 'leaderboard') {
    for (const [dx, height] of [[-5, 7], [0, 12], [5, 5]]) line(c, [[ix + dx, iy], [ix + dx, iy - height]], iconColor, 2.1);
  } else {
    outline(c, [[ix - 6, iy - 10], [ix + 7, iy - 5], [ix - 6, iy]], iconColor, 1.1);
  }
}

function menuCursor(c, cursor, dwellProgress) {
  if (!Number.isFinite(cursor?.x) || !Number.isFinite(cursor?.y)) return;
  const x = Math.max(10, Math.min(W - 10, cursor.x));
  const y = Math.max(10, Math.min(H - 10, cursor.y));
  c.beginPath(); c.arc(x, y, 2, 0, Math.PI * 2); c.fillStyle = C.bright; c.fill();
  if (!(dwellProgress > 0)) return;
  c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); strokePath(c, C.guide, 1.15);
  c.beginPath(); c.arc(x, y, 9, -Math.PI / 2, (clamp01(dwellProgress) * 2 - 0.5) * Math.PI);
  strokePath(c, C.bright, 1.65);
}

function home(c, model) {
  const menu = model.menu || {};
  const songs = (menu.songs || model.courses || []).slice(0, 3);
  const focus = menu.focus || 'song', songIndex = menu.songIndex ?? 0;
  clearBlack(c);
  menuRoom(c, menu.cursor);
  text(c, '节奏开跳', 27, 55, 26, C.bright);
  text(c, '选曲', 455, 56, 14, C.text, 'right');
  line(c, [[26, 70], [454, 70]], C.guide, 0.9);
  line(c, [[26, 70], [77, 70]], C.bright, 1.45);
  for (const target of menuTargets(songs.length)) {
    const selected = target.index === songIndex;
    const active = target.focus === focus && (focus !== 'song' || selected);
    if (target.focus === 'song') menuSong(c, target, songs[target.index], active, selected, menu);
    else menuModule(c, target, active);
  }
  fillPolygon(c, [[77, 286], [403, 286], [403, 328], [77, 328]], C.black);
  text(c, model.message || '滑动切换 · 单击确认', 240, 303, 12, C.text, 'center', false, 324);
  text(c, '也可看向目标并停留', 240, 322, 11, C.secondary, 'center');
  menuCursor(c, menu.cursor, menu.dwellProgress);
}

function cut(value, limit) {
  const textValue = String(value || '');
  return textValue.length > limit ? textValue.slice(0, limit - 1) + '…' : textValue;
}

function leaderboardTabs(c, songs, selectedId) {
  const w = 436 / songs.length;
  line(c, [[22, 76], [458, 76]], C.guide, 0.8);
  for (const [index, song] of songs.entries()) {
    const x = 22 + index * w, active = song.id === selectedId;
    text(c, song.title, x + w / 2, 63, 13, active ? C.bright : C.secondary, 'center', active, w - 16);
    if (active) line(c, [[x + 9, 76], [x + w - 9, 76]], C.bright, 2);
  }
}

function leaderboard(c, model) {
  const board = model.leaderboard || {};
  const songs = (board.songs || model.courses || []).slice(0, 3);
  const selected = songs.find(song => song.id === board.songId) || songs[0];
  const showTabs = songs.length > 1;
  const titleY = showTabs ? 98 : 61;
  clearBlack(c);
  text(c, '排行榜', 22, 34, 22, C.text, 'left', true);
  if (Number.isInteger(board.totalPlayers) && board.totalPlayers > 0) {
    text(c, `${board.totalPlayers} 人`, 458, 34, 11, C.secondary, 'right');
  }
  if (showTabs) leaderboardTabs(c, songs, selected.id);
  text(c, (showTabs ? selected.title : board.songTitle || selected?.title) || '', 22, titleY, 14, C.text, 'left', true, 305);
  text(c, '全时段 · 本曲', 458, titleY, 10, C.secondary, 'right');
  line(c, [[22, titleY + 11], [458, titleY + 11]], C.guide, 0.8);

  if (board.status === 'loading' || board.status === 'idle') {
    text(c, '正在读取排行榜…', 240, 178, 14, C.text, 'center');
    text(c, '成绩会保存到眼镜，网络恢复后再试', 240, 200, 9, C.secondary, 'center');
  } else if (board.status === 'error') {
    text(c, board.message || '排行榜暂不可用', 240, 172, 15, C.text, 'center');
    text(c, '本地成绩已保存', 240, 196, 10, C.secondary, 'center');
  } else if (!board.entries?.length) {
    text(c, '还没有人上榜', 240, 172, 16, C.bright, 'center');
    text(c, '完成一局，做第一个', 240, 196, 10, C.secondary, 'center');
  } else {
    const rows = board.entries.slice(0, 8);
    for (let i = 0; i < rows.length; i++) {
      const entry = rows[i], y = titleY + 32 + i * 24, mine = entry.is_me === 1;
      const color = mine ? C.bright : C.text;
      if (mine) line(c, [[18, y - 13], [18, y + 5]], C.bright, 2.2);
      text(c, String(entry.position ?? i + 1).padStart(2, '0'), 30, y, 13, mine ? C.bright : C.secondary);
      text(c, cut(entry.display_name || '玩家', 11), 54, y, 12, color);
      if (mine) text(c, '你', 196, y, 9, C.bright);
      text(c, String(entry.score ?? 0), 452, y, 14, color, 'right', mine);
    }
    if (board.me && board.me.position > rows.length && !rows.some(entry => entry.is_me === 1)) {
      text(c, `你 · 第 ${board.me.position} 名 · ${board.me.score}`, 22, 320, 11, C.bright);
    }
  }
  text(c, showTabs ? '滑动切换曲目 · 单击返回' : '单击返回', 240, 342, 11, C.secondary, 'center');
}

const TUTORIAL_COPY = {
  'dodge-left': { instruction: '左脚向左迈一小步', detail: '身体跟着移过去' },
  'dodge-right': { instruction: '右脚向右迈一小步', detail: '身体跟着移过去' },
  jump: { instruction: '原地轻跳，双脚离地', detail: '落地站稳' },
};

function demoProgress(phase, start, end) {
  const t = clamp01((phase - start) / (end - start));
  return t * t * (3 - 2 * t);
}

function tutorialFigure(c, { x, ground, action, phase = 0 }) {
  const direction = action === 'dodge-left' ? -1 : action === 'dodge-right' ? 1 : 0;
  const step = demoProgress(phase, 0.20, 0.50);
  const weight = demoProgress(phase, 0.31, 0.62);
  const jumpFlight = action === 'jump' ? clamp01((phase - 0.32) / 0.29) : 0;
  const lift = 4 * jumpFlight * (1 - jumpFlight) * 22;
  const dip = action === 'jump'
    ? 9 * Math.sin(Math.PI * clamp01((phase - 0.08) / 0.24)) + 5 * Math.sin(Math.PI * clamp01((phase - 0.61) / 0.19))
    : direction ? 4 * weight : 0;
  const hipX = x + direction * 12 * weight, hipY = ground - 30 + dip - lift;
  // Tilt the whole upper body around the hips as weight shifts onto the leading foot.
  const tilt = direction * weight * 0.22;
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  const upper = (dx, dy) => [hipX + dx * cos - dy * sin, hipY + dx * sin + dy * cos];

  line(c, [[x - 48, ground + 2], [x + 48, ground + 2]], C.guide, 0.8);
  if (direction) {
    const tip = x + direction * 27, y = ground + 13;
    line(c, [[x, y], [tip, y]], C.frame, 0.95);
    line(c, [[tip - direction * 5, y - 4], [tip, y], [tip - direction * 5, y + 4]], C.frame, 0.95);
  }

  c.beginPath();
  c.arc(...upper(0, -36), 6, 0, 2 * Math.PI);
  addPolyline(c, [upper(0, -26), [hipX, hipY]]);
  addPolyline(c, [upper(-9, -21), upper(9, -21)]);
  addPolyline(c, [[hipX - 5, hipY], [hipX + 5, hipY]]);
  for (const side of [-1, 1]) {
    const stepping = side === direction;
    const ankleX = x + side * 8 + (stepping ? direction * 18 * step : 0);
    const ankleY = ground - 3 - lift - (stepping ? 5 * Math.sin(Math.PI * step) : 0);
    const legX = hipX + side * 5;
    const kneeX = (legX + ankleX) / 2 + side * (3 + dip * 0.42);
    addPolyline(c, [[legX, hipY], [kneeX, (hipY + ankleY) / 2],
      [ankleX, ankleY], [ankleX, ankleY + 3], [ankleX + side * 5, ankleY + 3]]);
    const armSwing = lift * 0.6;
    addPolyline(c, [upper(side * 9, -21), upper(side * (15 + armSwing * 0.22), -9),
      upper(side * (15 + armSwing * 0.55), 1 - armSwing)]);
  }
  strokePath(c, C.text, 1.7);
}

function tutorialReady(c) {
  text(c, '新手教程', 17, 31, 13, C.text, 'left', true);
  text(c, '先站稳，再开始', 240, 89, 24, C.text, 'center');
  tutorialFigure(c, { x: 240, ground: 194 });
  text(c, '找一块空旷、防滑的地方', 240, 225, 16, C.text, 'center');
  text(c, '站起来，面向正前方', 240, 249, 13, C.secondary, 'center');
  rounded(c, 154, 269, 172, 44, 5, null, C.bright, 1.5);
  text(c, '单击镜腿开始', 240, 297, 17, C.bright, 'center');
  text(c, '返回键回到主菜单', 240, 342, 10, C.secondary, 'center');
}

function tutorialTarget(c, action, pose, successAge) {
  const lane = LANE_BY_ACTION.get(action);
  if (!laneEnabled(lane)) return;
  const camera = createStageCamera(pose);
  const pad = PADS[lane];
  const corners = screenPolygon(c, PAD_CORNERS[lane], camera);
  if (corners) outline(c, corners, C.frame, 1.15);
  note(c, { lane, action }, 0, camera, true);
  if (successAge === undefined) return;
  const point = projectWorld([pad.x, pad.y + NOTE_LIFT, pad.z], camera);
  if (!point) return;
  impact(c, pad, camera, point, successAge, HIT_STYLES.good);
  text(c, 'GOOD', point.x, judgementLabelY(pad, camera) ?? point.y + 30, 21, C.bright, 'center');
}

function tutorialStage(c, { tutorial, pose, body, showMotionDebug }) {
  const { action, count = 3, index = 0, attempt = 1, phase = 'demo', phaseElapsedMs = 0, hint, completed } = tutorial ?? {};
  text(c, '新手教程', 17, 31, 13, C.text, 'left', true);
  text(c, `${Math.min(count, index + 1)} / ${count}`, 463, 31, 13, C.text, 'right', true);
  text(c, '双击返回主菜单', 240, 342, 10, C.secondary, 'center');
  const copy = TUTORIAL_COPY[action];
  if (!copy) return;
  if (phase === 'success') {
    tutorialTarget(c, action, pose, phaseElapsedMs);
    if (completed) {
      text(c, '教程完成', 240, 106, 24, C.bright, 'center');
      text(c, '接下来可以开始正式曲目', 240, 132, 13, C.text, 'center');
    }
    return;
  }
  const demo = phase === 'demo';
  const prompt = demo ? '看示范' : attempt > 1 ? '再做一次' : '轮到你';
  text(c, `${ACTION_PROMPT[action]} · ${prompt}`, 240, 93, 20, C.text, 'center');
  if (demo) {
    tutorialFigure(c, { x: 240, ground: 201, action, phase: clamp01(phaseElapsedMs / TUTORIAL_DEMO_MS) });
  } else {
    tutorialTarget(c, action, pose);
    if (showMotionDebug === true) motionDebugHud(c, body);
  }
  text(c, copy.instruction, 240, demo ? 250 : 292, 17, C.bright, 'center');
  text(c, demo ? copy.detail : hint || copy.detail, 240, demo ? 275 : 315, 13, C.text, 'center');
}
function result(c, model) {
  const state = model.state;
  clearBlack(c);
  text(c, 'SESSION COMPLETE', 22, 27, 9, C.secondary);
  const title = state.accuracy >= 90 ? '每一拍，都很到位。' : state.accuracy >= 50 ? '节奏，越来越对了。' : '第一步，就是跟上自己。';
  text(c, title, 22, 59, 23);
  text(c, `${state.course.title} · ${state.course.durationMs / 1000} 秒`, 23, 82, 11, C.secondary);
  text(c, String(state.score), 22, 132, 43, C.bright);
  text(c, '本局得分', 25, 149, 9, C.secondary);
  const metrics = [['节拍准确率', `${state.accuracy}%`], ['最佳连击', state.maxCombo], ['PERFECT', state.perfect]];
  for (let i = 0; i < metrics.length; i++) {
    const x = 22 + i * 149;
    line(c, [[x, 167], [x + 138, 167]], C.guide, 0.8);
    text(c, metrics[i][0], x + 3, 187, 10, C.secondary);
    text(c, metrics[i][1], x + 3, 215, 23);
  }
  text(c, `${state.good} GOOD · ${state.ok ?? 0} OK · ${state.miss} MISS`, 23, 249, 10, C.secondary);
  const share = model.posture;
  if (share) text(c, `动作 左${share['dodge-left']}% 右${share['dodge-right']}% 跳${share.jump}%`, 23, 266, 9, C.secondary);
  text(c, model.saved || '成绩已保存在眼镜', 458, 249, 10, C.secondary, 'right');
  const selected = Number.isInteger(model.resultAction) && model.resultAction >= 0 && model.resultAction <= 2 ? model.resultAction : 0;
  const labels = ['再跳一次', '排行榜', '回到主菜单'];
  for (let i = 0; i < labels.length; i++) {
    const x = 22 + i * 149, focused = i === selected;
    rounded(c, x, 281, 138, 41, 4, null, focused ? C.bright : C.frame, focused ? 1.7 : 0.8);
    text(c, labels[i], x + 69, 307, 13, focused ? C.bright : C.text, 'center', focused);
  }
  text(c, '滑动选择 · 单击确认', 240, 342, 10, C.secondary, 'center');
}

export function renderSpatial(c, model = {}) {
  const mode = model.mode || 'home', state = model.state;
  if (mode === 'home') {
    home(c, model);
    if (typeof c.flush === 'function') c.flush();
    return;
  }
  if (mode === 'result' && state) {
    result(c, model);
    if (typeof c.flush === 'function') c.flush();
    return;
  }
  if (mode === 'leaderboard') {
    leaderboard(c, model);
    if (typeof c.flush === 'function') c.flush();
    return;
  }
  if (!['playing', 'paused', 'calibrating', 'tutorial-ready', 'tutorial'].includes(mode)) return renderBase(c, model);
  clearBlack(c);
  if (mode === 'calibrating') {
    calibrationStage(c, model);
  } else if (mode === 'tutorial-ready') {
    tutorialReady(c);
  } else if (mode === 'tutorial') {
    tutorialStage(c, model);
  } else if (mode === 'paused') {
    rounded(c, 105, 121, 270, 105, 6, null, C.frame);
    text(c, '已暂停', 240, 162, 24, C.bright, 'center');
    text(c, model.message || '单击继续 · 返回主菜单', 240, 196, 12, C.text, 'center');
    if (model.perf?.text) text(c, model.perf.text, 240, 246, 8, C.secondary, 'center');
  } else if (state) {
    const t = state.elapsedMs, bpm = state.course?.bpm || 108;
    // Display calibration advances only predictive visuals. It is not an
    // intentional delay or a way to fake better timing: judgement, score, HUD
    // progress and the age of an already-triggered hit use the real chart clock.
    const visualT = displayElapsedMs(state, model.displayOffsetMs);
    const camera = createStageCamera(model.pose);
    stage(c, state, visualT, bpm, camera, model.body);
    feedback(c, state, t, camera);
    hud(c, state);
    if (model.showMotionDebug === true) motionDebugHud(c, model.body);
    perfMeter(c, model.perf);
    if (model.message) text(c, model.message, 245, 346, 9, C.text, 'center');
  }
  if (typeof c.flush === 'function') c.flush();
}
