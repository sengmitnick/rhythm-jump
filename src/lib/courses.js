import { SERENITY_SONGS } from './serenity-songs.js';

// Choreographed charts for a four-move vocabulary: jump, squat, dodge left,
// dodge right. The moves sit on a four-arm pad in front of the player, the way
// a dance pad sits underfoot: up = jump, down = squat, left / right = dodge.
//
// Every phrase is 8 beats. A phrase is small enough to read ahead, and every
// fourth phrase swaps to a wall — a lower bar, a low beam or a side wall — which
// is the same four-move judgement drawn as an obstacle instead of a tile.
export const LANES = [
  { action: 'jump', label: '起跳', dir: 'up', color: '#23dfff' },
  { action: 'duck', label: '下蹲', dir: 'down', color: '#9c6bff' },
  { action: 'dodge-left', label: '左闪', dir: 'left', color: '#ff54ce' },
  { action: 'dodge-right', label: '右闪', dir: 'right', color: '#ffc85a' },
];
export const LABELS = { jump: '起跳', duck: '下蹲', 'dodge-left': '左闪', 'dodge-right': '右闪' };
export const DIRECTIONS = { jump: 'up', duck: 'down', 'dodge-left': 'left', 'dodge-right': 'right' };
export const LANE_BY_ACTION = new Map(LANES.map(lane => [lane.action, LANES.indexOf(lane)]));
export const LANE_BY_DIRECTION = new Map(LANES.map((lane, index) => [lane.dir, index]));

// Phrase banks. Two rules shape them:
//   1. A run of the same move on consecutive beats is one sustained posture —
//      the "噔噔噔噔" of a long tone. The player holds the pose and every beat
//      still scores.
//   2. Two *different* moves are kept at least two beats apart, because that is
//      how long a real lean or squat takes to settle. Same-move repeats can sit
//      one beat apart; nothing has to move.
const BOOKS = {
  practice: [
    [[0, 'dodge-left'], [1, 'dodge-left'], [2, 'dodge-left'], [4, 'duck'], [5, 'duck'], [7, 'dodge-right']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [3, 'jump'], [5, 'dodge-left'], [6, 'dodge-left']],
    [[0, 'duck'], [1, 'duck'], [3, 'dodge-right'], [5, 'jump'], [7, 'dodge-left']],
  ],
  stretch: [
    [[0, 'dodge-left'], [1, 'dodge-left'], [2, 'dodge-left'], [4, 'duck'], [5, 'duck'], [7, 'dodge-right']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [3, 'dodge-left'], [4, 'dodge-left'], [6, 'jump']],
    [[0, 'jump'], [2, 'dodge-right'], [3, 'dodge-right'], [5, 'dodge-left'], [6, 'dodge-left']],
    [[0, 'duck'], [1, 'duck'], [2, 'duck'], [4, 'dodge-right'], [5, 'dodge-right'], [6, 'dodge-right']],
    [[0, 'dodge-left'], [1, 'dodge-left'], [3, 'duck'], [5, 'jump'], [7, 'dodge-right']],
    [[0, 'dodge-right'], [2, 'dodge-left'], [4, 'dodge-right'], [6, 'dodge-left']],
  ],
  step: [
    [[0, 'dodge-left'], [1, 'dodge-left'], [2, 'dodge-left'], [3, 'dodge-left'], [5, 'duck'], [6, 'duck']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [2, 'dodge-right'], [4, 'jump'], [6, 'dodge-left'], [7, 'dodge-left']],
    [[0, 'duck'], [1, 'duck'], [2, 'duck'], [3, 'duck'], [5, 'dodge-right'], [6, 'dodge-right'], [7, 'dodge-right']],
    [[0, 'dodge-left'], [2, 'dodge-right'], [3, 'dodge-right'], [5, 'dodge-left'], [6, 'dodge-left']],
    [[0, 'jump'], [2, 'duck'], [3, 'duck'], [5, 'dodge-right'], [6, 'dodge-right'], [7, 'dodge-right']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [3, 'dodge-left'], [4, 'dodge-left'], [6, 'duck']],
  ],
  jump: [
    [[0, 'jump'], [2, 'dodge-left'], [3, 'dodge-left'], [4, 'dodge-left'], [6, 'duck'], [7, 'duck']],
    [[0, 'dodge-left'], [1, 'dodge-left'], [3, 'jump'], [5, 'dodge-right'], [6, 'dodge-right'], [7, 'dodge-right']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [2, 'dodge-right'], [4, 'duck'], [5, 'duck'], [7, 'jump']],
    [[0, 'duck'], [1, 'duck'], [3, 'dodge-left'], [4, 'dodge-left'], [6, 'dodge-right'], [7, 'dodge-right']],
    [[0, 'dodge-left'], [2, 'jump'], [4, 'dodge-right'], [5, 'dodge-right'], [6, 'dodge-right']],
    [[0, 'dodge-right'], [2, 'duck'], [3, 'duck'], [4, 'duck'], [6, 'dodge-left'], [7, 'dodge-left']],
  ],
};

// Walls reuse the same four moves; only the drawing changes.
const WALLS = {
  stretch: ['duck', 'dodge-left', 'dodge-right'],
  step: ['duck', 'dodge-right', 'jump', 'dodge-left'],
  jump: ['duck', 'jump', 'dodge-right', 'dodge-left'],
};

// Walls read badly once the judgement is "be in this posture": a solid beam you
// are supposed to walk through makes no sense. Kept behind a switch so the
// drawing and the four-move rule can come back later.
export const ENABLE_WALLS = false;
// The squat is the only move that has to be integrated, and it is the one that
// keeps misfiring when the whole body moves. Off by default: three moves, three
// signals that are absolute.
export const ENABLE_DUCK = false;
export const ACTIVE_ACTIONS = ENABLE_DUCK
  ? ['dodge-left', 'dodge-right', 'duck', 'jump']
  : ['dodge-left', 'dodge-right', 'jump'];
// Without a squat, its slots become the opposite lateral move, which keeps the
// left-right alternation rhythm games are built on.
const remapAction = (action, index) => (action === 'duck' && !ENABLE_DUCK
  ? (index % 2 === 0 ? 'dodge-left' : 'dodge-right')
  : action);

const SECTIONS = [
  { id: 'warmup', label: '热身', from: 0 },
  { id: 'flow', label: '加速', from: 0.14 },
  { id: 'climax', label: '高潮', from: 0.7 },
];

function sectionAt(atMs, durationMs) {
  const p = atMs / durationMs;
  let index = 0;
  SECTIONS.forEach((section, i) => { if (p >= section.from) index = i; });
  return index;
}

function buildSections(durationMs) {
  return SECTIONS.map((section, index) => ({
    index, id: section.id, label: section.label,
    startMs: Math.round(section.from * durationMs),
    endMs: index === SECTIONS.length - 1 ? durationMs : Math.round(SECTIONS[index + 1].from * durationMs),
  }));
}

// A scripted chart, used by the practice level where the order of the moves
// matters more than the musical phrasing: left, right, squat, jump, then mixed.
function buildExplicit({ id, title, bpm, durationMs, focus, color, root, beats, firstMs = 2600, music = null, minGapMs = 0, version = 3 }) {
  const beatMs = 60000 / bpm;
  const raw = beats.map(([beat, action], index) => {
    const mapped = remapAction(action, index);
    return { atMs: Math.round(firstMs + beat * beatMs), action: mapped, lane: LANE_BY_ACTION.get(mapped) };
  }).sort((a, b) => a.atMs - b.atMs);
  // Keep cues on the music grid and give players time to finish each move.
  const kept = [];
  for (const cue of raw) {
    const previous = kept[kept.length - 1];
    if (previous) {
      const gap = cue.atMs - previous.atMs;
      const needed = cue.action === previous.action ? (cue.action === 'jump' ? 900 : 400) : 620;
      if (gap < Math.max(needed, minGapMs)) continue;
    }
    kept.push(cue);
  }
  const events = kept.map((cue, index) => ({
    id: `${id}-0-${index}`, atMs: cue.atMs,
    kind: 'note', action: cue.action, lane: cue.lane, group: 0,
  }));
  const sections = buildSections(durationMs);
  for (const event of events) event.section = sectionAt(event.atMs, durationMs);
  return { id, title, bpm, durationMs, focus, color, root, music, groups: 1, events, sections, version };
}

function buildCourse({ id, title, bpm, durationMs, focus, color, root, book, walls }) {
  const beatMs = 60000 / bpm;
  const phraseBeats = 8;
  const phraseMs = beatMs * phraseBeats;
  const firstNoteMs = 4000;
  const lastNoteMs = durationMs - 1100;
  const events = [];
  let slot = 0;

  for (let t = firstNoteMs; t < lastNoteMs; t += phraseMs, slot++) {
    const isWall = ENABLE_WALLS && slot >= 3 && slot % 4 === 3;
    if (isWall) {
      const action = walls[Math.floor(slot / 4) % walls.length];
      const mapped = remapAction(action, events.length);
      events.push({
        // Beat 2 leaves the previous phrase's tail two beats of clearance.
        id: `${id}-${slot}-w`, atMs: Math.round(t + beatMs * 2), kind: 'wall',
        action: mapped, lane: LANE_BY_ACTION.get(mapped), group: slot,
      });
      continue;
    }
    // Slot 0 is the entrance cue and always uses the first phrase; later slots
    // walk the bank with a coprime step so the level keeps moving.
    const phrase = book[slot === 0 ? 0 : (slot * 5 + 1) % book.length];
    phrase.forEach(([beat, action], n) => {
      const mapped = remapAction(action, events.length + n);
      events.push({
        id: `${id}-${slot}-${n}`, atMs: Math.round(t + beat * beatMs),
        kind: 'note', action: mapped, lane: LANE_BY_ACTION.get(mapped), group: slot,
      });
    });
  }

  const ordered = events
    .filter(event => event.atMs >= firstNoteMs && event.atMs <= lastNoteMs)
    .sort((a, b) => a.atMs - b.atMs);
  const chart = [];
  for (const event of ordered) {
    const previous = chart[chart.length - 1];
    if (previous) {
      const gap = event.atMs - previous.atMs;
      // Same move on the next beat is a sustained posture; anything else needs
      // enough time for the body to actually settle into the new position.
      const needed = event.action === previous.action ? (event.action === 'jump' ? 900 : 400) : 620;
      if (gap < needed) continue;
    }
    chart.push(event);
  }

  const sections = buildSections(durationMs);
  for (const event of chart) event.section = sectionAt(event.atMs, durationMs);

  return {
    id, title, bpm, durationMs, focus, color, root,
    groups: slot, events: chart, sections, version: 3,
  };
}

// Chart for 「Party Sector」 (Joth, CC0, 120 BPM). Every cue sits on a beat of
// the track itself: the bar numbers in the comments are the music's bars, not
// an abstract grid, so the cues land with what is playing.
const PRACTICE_BEATS = [
  // bar 2 -- the groove has settled
  [4, 'dodge-left'], [5, 'dodge-left'], [6, 'dodge-left'],
  [8, 'dodge-right'], [9, 'dodge-right'],
  // bar 4
  [12, 'duck'], [13, 'duck'],
  [15, 'jump'],
  [17, 'dodge-right'], [18, 'dodge-right'],
  // bar 6
  [20, 'dodge-left'], [21, 'dodge-left'],
  [23, 'duck'], [24, 'duck'],
  [26, 'jump'],
  // bar 8
  [28, 'dodge-right'], [29, 'dodge-right'],
  [31, 'jump'],
  [33, 'dodge-left'], [34, 'dodge-left'],
  [36, 'jump'],
];

// Bars 11-48 of the same recording. The density follows what the track is
// doing: a steady groove, a busier middle, a quiet stretch, then the loud
// closing section. Nothing is random — the blocks are tiled in order.
const PARTY_BLOCKS = {
  steady: [
    [[0, 'dodge-left'], [1, 'dodge-left'], [3, 'dodge-right'], [5, 'duck'], [6, 'duck']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [3, 'dodge-left'], [5, 'jump']],
    [[0, 'duck'], [1, 'duck'], [3, 'dodge-left'], [4, 'dodge-left'], [6, 'dodge-right'], [7, 'dodge-right']],
    [[0, 'jump'], [2, 'dodge-right'], [3, 'dodge-right'], [5, 'dodge-left'], [6, 'dodge-left']],
  ],
  busy: [
    [[0, 'dodge-left'], [1, 'dodge-left'], [2, 'dodge-left'], [4, 'dodge-right'], [5, 'dodge-right'], [7, 'jump']],
    [[0, 'duck'], [1, 'duck'], [3, 'jump'], [5, 'dodge-right'], [6, 'dodge-right'], [7, 'dodge-right']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [3, 'duck'], [4, 'duck'], [6, 'jump']],
    [[0, 'jump'], [2, 'dodge-left'], [3, 'dodge-left'], [5, 'duck'], [6, 'duck'], [7, 'jump']],
  ],
  quiet: [
    [[0, 'dodge-left'], [1, 'dodge-left'], [2, 'dodge-left'], [5, 'dodge-right'], [6, 'dodge-right']],
    [[0, 'duck'], [1, 'duck'], [2, 'duck'], [5, 'jump']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [4, 'duck'], [5, 'duck']],
  ],
  climax: [
    [[0, 'jump'], [1, 'dodge-left'], [2, 'dodge-left'], [4, 'dodge-right'], [5, 'dodge-right'], [6, 'duck'], [7, 'duck']],
    [[0, 'dodge-right'], [1, 'dodge-right'], [3, 'jump'], [4, 'dodge-left'], [5, 'dodge-left'], [7, 'duck']],
    [[0, 'duck'], [1, 'duck'], [2, 'jump'], [4, 'dodge-left'], [5, 'dodge-left'], [6, 'dodge-right'], [7, 'dodge-right']],
  ],
};

// 0-40 beats is the tutorial, then four sections of the recording.
const PARTY_SECTIONS = [
  { from: 40, to: 92, bank: 'steady' },
  { from: 92, to: 128, bank: 'busy' },
  { from: 128, to: 156, bank: 'quiet' },
  { from: 156, to: 190, bank: 'climax' },
];

function partyBeats() {
  const cues = PRACTICE_BEATS.map(([beat, action]) => [beat, action]);
  for (const section of PARTY_SECTIONS) {
    const bank = PARTY_BLOCKS[section.bank];
    let slot = 0;
    for (let base = section.from; base + 7 < section.to; base += 8, slot += 1) {
      for (const [beat, action] of bank[slot % bank.length]) {
        const at = base + beat;
        if (at < section.to) cues.push([at, action]);
      }
    }
  }
  return cues;
}

function buildImportedCourse({ notes, ...song }) {
  const { id, durationMs } = song;
  // The source timestamps are already relative to the original recording.
  // Keep every imported arrow at its source time, including its spacing.
  const events = notes.map(([atMs, action], index) => ({
    id: `${id}-${index}`, atMs, action, lane: LANE_BY_ACTION.get(action),
    kind: 'note', group: 0, section: sectionAt(atMs, durationMs),
  }));
  return {
    ...song, native: true, version: 1, events, sections: buildSections(durationMs),
  };
}

const COURSES = [
  buildExplicit({
    id: 'practice', title: 'Party Sector', bpm: 120, durationMs: 20000,
    focus: 'Joth · CC0 授权', color: '#23dfff', root: 220,
    beats: PRACTICE_BEATS, firstMs: 0, music: '/assets/audio/party-sector.mp3',
  }),
  buildExplicit({
    id: 'party-full', title: 'Party Sector', bpm: 120, durationMs: 96000,
    focus: 'Joth · CC0 授权', color: '#9c6bff', root: 196,
    // Repeated sidesteps need a full out-and-back. At 120 BPM allow two beats.
    minGapMs: 1000, version: 4,
    beats: partyBeats(), firstMs: 0, music: '/assets/audio/party-sector-full.mp3',
  }),
  buildCourse({
    id: 'stretch', title: '伸展上拍', bpm: 108, durationMs: 60000,
    focus: '左闪 · 起跳 · 下蹲', color: '#23dfff', root: 220,
    book: BOOKS.stretch, walls: WALLS.stretch,
  }),
  buildCourse({
    id: 'step', title: '踏拍穿行', bpm: 120, durationMs: 75000,
    focus: '左右交替 · 低梁 · 低栏', color: '#9c6bff', root: 196,
    book: BOOKS.step, walls: WALLS.step,
  }),
  buildCourse({
    id: 'jump', title: '全身开跳', bpm: 132, durationMs: 90000,
    focus: '起跳连打 · 重心切换', color: '#ff54ce', root: 246.94,
    book: BOOKS.jump, walls: WALLS.jump,
  }),
  ...SERENITY_SONGS.map(buildImportedCourse),
];

export function getCourses() { return COURSES; }
export function getCourse(id) { return COURSES.find(c => c.id === id); }
export function sectionLabel(course, index) { return course?.sections?.[index]?.label || ''; }
