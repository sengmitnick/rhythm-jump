import test from 'node:test';
import assert from 'node:assert/strict';
import { researchExportRows, researchExportLines, RESEARCH_MARKER } from '../src/lib/research-export.js';

const INDEX_KEY = 'rhythm-research-index-v1';
const chunkKey = (id, index) => `rhythm-research-v1:${id}:${index}`;

function storage(runs) {
  const store = new Map();
  store.set(INDEX_KEY, { schemaVersion: 1, runs });
  for (const run of runs) {
    const rows = [];
    for (let seq = 0; seq < run.records; seq++) rows.push({ runId: run.id, seq, type: 'posture', action: 'stand' });
    store.set(chunkKey(run.id, 0), rows);
  }
  return { getStorageSync: key => store.get(key), removeStorageSync: key => store.delete(key), setStorageSync: () => {} };
}

function run(id, records) {
  return {
    id, meta: { id, courseId: 'stretch' }, status: 'finished', reason: 'completed', endedAtMs: 1000,
    chunks: 1, chunkSizes: [records], records, truncatedRecords: 0, storageErrors: 0, createdAt: 1,
  };
}

test('a finished run can hand its log over without the export page', () => {
  const s = storage([run('a', 3), run('b', 2)]);
  const { runCount, eventCount, rows } = researchExportRows(s, { exportId: 'x1' });
  assert.equal(runCount, 2);
  assert.equal(eventCount, 5);
  assert.equal(rows[0].kind, 'begin');
  assert.equal(rows.at(-1).kind, 'end');
  assert.equal(rows.at(-1).eventCount, 5);
  assert.ok(rows.filter(row => row.kind === 'event').every(row => row.event.type === 'posture'));
});

test('emitted lines carry the collector marker and stay parseable', () => {
  const lines = researchExportLines(storage([run('a', 2)]), { exportId: 'x2' });
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    assert.ok(line.startsWith(RESEARCH_MARKER));
    const row = JSON.parse(line.slice(RESEARCH_MARKER.length));
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.exportId, 'x2');
  }
});

test('no runs still produces a valid empty export', () => {
  const { runCount, eventCount, rows } = researchExportRows(storage([]), { exportId: 'x3' });
  assert.equal(runCount, 0);
  assert.equal(eventCount, 0);
  assert.deepEqual(rows.map(row => row.kind), ['begin', 'end']);
});
