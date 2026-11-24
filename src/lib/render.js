import { LANES, LABELS, DIRECTIONS } from './courses.js';
export const GLASSES_INK = Object.freeze({
  black: '#000000', bright: '#40ff5e', text: 'rgba(64,255,94,0.82)',
  secondary: 'rgba(64,255,94,0.62)', frame: 'rgba(64,255,94,0.48)',
  guide: 'rgba(64,255,94,0.28)', trace: 'rgba(64,255,94,0.14)',
});
const C = GLASSES_INK;
const W = 480, H = 352;

// A four-arm pad in front of the player, read the way a dance pad is read:
// the arm you land on is the move you make. It replaces four vertical lanes
// plus eight limb icons with one shape and one direction.
const PAD_CX = 240, PAD_CY = 258, PAD_ARM = 48, PAD_HALF = 22;
export const PAD_POS = [
  { x: PAD_CX, y: PAD_CY - PAD_ARM },
  { x: PAD_CX, y: PAD_CY + PAD_ARM },
  { x: PAD_CX - PAD_ARM, y: PAD_CY },
  { x: PAD_CX + PAD_ARM, y: PAD_CY },
];
const VP = { x: 240, y: 92 };
const HORIZON_MS = 2800;
const TIER_COLOR = [C.secondary, C.text, C.bright, C.bright];

function rr(c, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  c.moveTo(x + rad, y);
  c.lineTo(x + w - rad, y); c.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
  c.lineTo(x + w, y + h - rad); c.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
  c.lineTo(x + rad, y + h); c.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
  c.lineTo(x, y + rad); c.arc(x + rad, y + rad, rad, Math.PI, Math.PI * 1.5);
  c.closePath();
}
function box(c, x, y, w, h, color, r = 6) { c.beginPath(); rr(c, x, y, w, h, r); c.fillStyle = color; c.fill(); }
function frame(c, x, y, w, h, color, r = 6, width = 1) { c.beginPath(); rr(c, x, y, w, h, r); c.strokeStyle = color; c.lineWidth = width; c.stroke(); }
function text(c, s, x, y, size = 10, color = C.text, align = 'left', weight = '') {
  c.font = `${weight || (size >= 16 ? 'bold ' : '')}${size}px sans-serif`;
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y);
}
function line(c, points, color, width = 1) {
  c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
  c.strokeStyle = color; c.lineWidth = width; c.stroke();
}
function hash(n) { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); }

// One glyph for four moves: an arrow pointing the way the body goes.
export function drawIcon(c, dir, x, y, size, color, active = false) {
  const s = size / 24;
  c.save(); c.translate(x, y); c.scale(s, s);
  const rot = dir === 'up' ? 0 : dir === 'down' ? Math.PI : dir === 'left' ? -Math.PI / 2 : Math.PI / 2;
  c.rotate(rot);
  c.beginPath();
  c.moveTo(0, -9); c.lineTo(8, -1); c.lineTo(3, -1); c.lineTo(3, 9);
  c.lineTo(-3, 9); c.lineTo(-3, -1); c.lineTo(-8, -1); c.closePath();
  c.fillStyle = color; c.fill();
  if (active) { c.strokeStyle = color; c.lineWidth = 1.2; c.stroke(); }
  c.restore();
}

function pad(c, laneIndex, t, flash, dim) {
  const pos = PAD_POS[laneIndex];
  const on = flash === laneIndex;
  const h = PAD_HALF;
  frame(c, pos.x - h, pos.y - h, h * 2, h * 2, on ? C.bright : dim ? C.trace : C.frame, 8, on ? 2 : 1);
  drawIcon(c, LANES[laneIndex].dir, pos.x, pos.y, 22, on ? C.bright : dim ? C.secondary : C.text);
}

function stage(c, s, t) {
  const beatMs = 60000 / s.course.bpm;
  const phase = ((t % beatMs) / beatMs);
  // Converging rails make the approach readable without any painted backdrop.
  for (let i = 0; i < LANES.length; i++) {
    const pos = PAD_POS[i];
    line(c, [[VP.x, VP.y], [pos.x, pos.y]], C.trace, 0.8);
  }
  // Beat ribs travel toward the pad and give the approach a pulse.
  for (let k = 0; k < 3; k++) {
    const p = ((phase + k / 3) % 1);
    const y = VP.y + (PAD_CY - VP.y) * Math.pow(p, 1.6);
    const grow = 0.18 + 0.82 * Math.pow(p, 1.3);
    line(c, [[VP.x - 150 * grow, y], [VP.x + 150 * grow, y]], C.trace, 0.8);
  }

  const nextLane = s.next ? s.next.lane : -1;
  for (let i = 0; i < LANES.length; i++) pad(c, i, t, s.last && s.last.grade !== 'miss' && t - s.last.atMs < 190 ? s.last.lane : -1, i !== nextLane);

  // Centre plate joins the four arms into one pad instead of four lanes.
  frame(c, PAD_CX - 18, PAD_CY - 18, 36, 36, C.guide, 6, 0.9);
  text(c, 'MOVE', PAD_CX, PAD_CY + 3, 7, C.trace, 'center');

  const visible = s.events
    .filter(e => !s.done.has(e.id) && e.atMs - t <= HORIZON_MS && e.atMs - t >= -260)
    .sort((a, b) => b.atMs - a.atMs);
  for (const e of visible) {
    const p = Math.max(0.04, 1 - (e.atMs - t) / HORIZON_MS);
    const k = Math.pow(p, 1.35);
    const target = PAD_POS[e.lane] || PAD_POS[0];
    const x = VP.x + (target.x - VP.x) * k;
    const y = VP.y + (target.y - VP.y) * k;
    const size = 40 * (0.42 + 0.58 * k);
    if (e.kind === 'wall') {
      // The same four moves, drawn as something to pass through.
      const w = (W - 90) * (0.3 + 0.7 * k) * (e.action === 'jump' || e.action === 'duck' ? 1 : 0.42);
      const h = (e.action === 'jump' ? 26 : 40) * (0.5 + 0.5 * k);
      const wx = e.action === 'dodge-left' ? VP.x + 40 : e.action === 'dodge-right' ? VP.x - 40 - w : VP.x - w / 2;
      frame(c, wx, y - h, w, h, C.text, 4, 1.4);
      for (let j = 0; j < 5; j++) line(c, [[wx + j * w / 5, y], [wx + (j + 0.5) * w / 5, y - h]], C.guide, 0.9);
      drawIcon(c, DIRECTIONS[e.action], VP.x, y - h * 0.5, Math.max(12, 20 * k), C.bright);
    } else {
      box(c, x - size / 2, y - size / 2, size, size, C.black, 6);
      frame(c, x - size / 2, y - size / 2, size, size, C.bright, 6, 1.8);
      drawIcon(c, DIRECTIONS[e.action], x, y, size * 0.5, C.bright);
      if (Math.abs(e.atMs - t) < 130) {
        c.globalAlpha = 0.35;
        frame(c, x - size / 2 - 5, y - size / 2 - 5, size + 10, size + 10, C.bright, 9, 2);
        c.globalAlpha = 1;
      }
    }
  }

  // Hit burst: rings plus deterministic sparks, no randomness per frame.
  if (s.last && t - s.last.atMs < 320 && s.last.lane >= 0 && s.last.grade !== 'miss') {
    const age = (t - s.last.atMs) / 320, pos = PAD_POS[s.last.lane];
    const col = s.last.grade === 'perfect' ? C.bright : C.text;
    c.globalAlpha = 1 - age;
    c.beginPath(); c.arc(pos.x, pos.y, 14 + 34 * age, 0, Math.PI * 2); c.strokeStyle = col; c.lineWidth = 3 * (1 - age); c.stroke();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * 2 * hash(s.last.atMs + i), r = 12 + 30 * age;
      c.beginPath(); c.arc(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r, 2.2 * (1 - age), 0, Math.PI * 2); c.fillStyle = col; c.fill();
    }
    c.globalAlpha = 1;
  }
}

function judgement(c, s, t) {
  const recent = s.last;
  if (!recent || t - recent.atMs > 520) return;
  const age = (t - recent.atMs) / 520;
  const color = recent.grade === 'miss' ? C.secondary : recent.grade === 'good' ? C.text : C.bright;
  const label = recent.grade === 'miss' ? 'MISS' : recent.grade === 'good' ? 'GOOD' : 'PERFECT';
  const scale = recent.grade === 'perfect' ? 1 + 0.18 * (1 - age) : 1;
  text(c, label, VP.x, 176 - 18 * age, Math.round(22 * scale), color, 'center', 'bold ');
  if (recent.offset && recent.grade !== 'miss') text(c, recent.offset === 'late' ? '稍晚' : '稍早', VP.x, 192, 8, C.secondary, 'center');
}

function topBar(c, s) {
  const tier = s.tier ?? 0;
  text(c, `COMBO ${s.combo}`, 12, 24, 15, TIER_COLOR[tier]);
  text(c, s.course.title, 12, 39, 9, C.secondary);
  line(c, [[150, 17], [340, 17]], C.guide);
  line(c, [[150, 17], [150 + Math.max(2, 190 * s.progress), 17]], C.bright, 1.5);
  for (const section of s.course.sections || []) {
    const x = 150 + 190 * Math.min(1, section.startMs / s.course.durationMs);
    line(c, [[x, 14], [x, 20]], C.frame);
  }
  text(c, s.course.sections?.[s.section]?.label || '', 245, 34, 8, C.secondary, 'center');
  const sec = Math.ceil(s.remainingMs / 1000);
  text(c, `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, 468, 24, 15, C.text, 'right');
  text(c, `${s.course.bpm} BPM`, 468, 39, 9, C.secondary, 'right');
  line(c, [[465, 58], [465, 186]], C.guide);
  const energyH = Math.max(2, 128 * (s.energy || 0));
  line(c, [[465, 186 - energyH], [465, 186]], C.text, 1.5);
  text(c, String(s.score), 468, 208, 19, C.text, 'right');
  text(c, 'SCORE', 468, 221, 8, C.secondary, 'right');
}

function hint(c, s, message) {
  const next = s.next;
  const tip = message || (next?.kind === 'wall' ? `前方：${LABELS[next.action]}` : next ? `下一拍 ${LABELS[next.action]}` : '保持呼吸，跟着节拍');
  text(c, tip, 240, 344, 9, message ? C.text : C.secondary, 'center');
}

export function render(c, model) {
  const { mode = 'home', courses = [], selected = 0, state: s, now = 0, message = '', countdown = 3, source = 'keyboard', saved = '' } = model;
  c.clearRect(0, 0, W, H); c.fillStyle = C.black; c.fillRect(0, 0, W, H);

  if (mode === 'home') {
    text(c, '节奏开跳', 22, 44, 27);
    text(c, 'RHYTHM GO / MOVE WITH THE BEAT', 23, 62, 9, C.secondary);
    text(c, '起跳 · 下蹲 · 左闪 · 右闪', 23, 86, 12, C.secondary);
    // Five levels now, so the rows are tighter: the whole list still fits.
    courses.forEach((course, i) => {
      const y = 86 + i * 50, on = i === selected;
      if (on) frame(c, 20, y, 440, 46, C.bright, 5, 1.7);
      else line(c, [[26, y + 46], [454, y + 46]], C.guide, 0.8);
      text(c, `0${i + 1}`, 36, y + 30, 16, on ? C.bright : C.secondary);
      text(c, course.title, 78, y + 21, 14);
      text(c, `${course.bpm} BPM  /  ${course.durationMs / 1000} 秒  /  ${course.focus}`, 78, y + 37, 9, C.secondary);
      if (on) text(c, '开始 ›', 442, y + 28, 12, C.bright, 'right');
    });
    text(c, message || '上下切换 · 单击开始 · 请留出一步的活动空间', 240, 346, 9, C.secondary, 'center');
  } else if (mode === 'calibrating') {
    text(c, '准备开跳', 240, 84, 24, C.text, 'center');
    const ring = 1 - Math.min(1, (3 - countdown) / 3);
    c.beginPath(); c.arc(240, 168, 46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ring); c.strokeStyle = C.bright; c.lineWidth = 2; c.stroke();
    text(c, String(Math.ceil(countdown)), 240, 182, 52, C.bright, 'center', 'bold ');
    text(c, source === 'imu' ? '站稳别动，正在校准你的动作基线' : '跟拍预备，松开身体跟着节拍', 240, 236, 12, C.secondary, 'center');
    text(c, message, 240, 262, 10, C.text, 'center');
  } else if (mode === 'sensor-error') {
    text(c, '暂未收到动作信号', 240, 118, 22, C.text, 'center');
    text(c, message || '传感器不可用，请检查眼镜宿主', 240, 152, 11, C.secondary, 'center');
    text(c, '单击重试 · 返回选关', 240, 212, 12, C.text, 'center');
  } else if (mode === 'result' && s) {
    text(c, '这一局，跳得不错', 22, 44, 23);
    text(c, s.course.title, 23, 65, 11, C.secondary);
    text(c, String(s.score).padStart(6, '0'), 22, 122, 40, C.bright);
    text(c, 'SCORE', 25, 141, 9, C.secondary);
    const metrics = [['节拍准确率', `${s.accuracy}%`], ['最佳连击', s.maxCombo], ['PERFECT', s.perfect], ['GOOD / MISS', `${s.good} / ${s.miss}`]];
    metrics.forEach(([a, b], i) => {
      const x = 22 + (i % 2) * 223, y = 164 + Math.floor(i / 2) * 60;
      line(c, [[x, y], [x + 213, y]], C.guide, 0.8);
      text(c, a, x + 12, y + 18, 9, C.secondary); text(c, b, x + 12, y + 42, 20);
    });
    text(c, saved || '成绩保存在本机', 240, 306, 10, C.secondary, 'center');
    text(c, '单击再来一局 · 返回选关', 240, 332, 10, C.text, 'center');
  } else if (mode === 'paused') {
    frame(c, 96, 130, 288, 92, C.frame, 6);
    text(c, '已暂停', 240, 168, 22, C.bright, 'center');
    text(c, '单击继续 · 返回选关', 240, 198, 11, C.text, 'center');
  } else if (s) {
    stage(c, s, s.elapsedMs);
    topBar(c, s);
    judgement(c, s, s.elapsedMs);
    hint(c, s, message);
  }
  if (typeof c.flush === 'function') c.flush();
}
