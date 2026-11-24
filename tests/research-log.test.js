import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchLog, readResearchLogs } from '../src/lib/research-log.js';

const indexKey = 'rhythm-research-index-v1';
const chunkKey = (id, index) => `rhythm-research-v1:${id}:${index}`;

function memoryStorage() {
  const data = new Map();
  return {
    data, removed: [], failRead: () => false, failWrite: () => false, failRemove: () => false,
    getStorageSync(key) {
      if (this.failRead(key)) throw new Error('read failed');
      return data.has(key) ? JSON.parse(data.get(key)) : undefined;
    },
    setStorageSync(key, value) {
      if (this.failWrite(key)) throw new Error('write failed');
      data.set(key, JSON.stringify(value));
    },
    removeStorageSync(key) {
      if (this.failRemove(key)) throw new Error('remove failed');
      this.removed.push(key);
      data.delete(key);
    },
  };
}

const row = (n = 0) => ({ type: 'imu', atMs: n, x: 0, y: 0, z: 9.81 });

function fixture(storage = memoryStorage(), onError = () => {}) {
  let now = 0, nextTask = 0;
  const scheduled = new Map();
  const log = new ResearchLog({
    storage, clock: () => now, onError,
    schedule(callback) { const handle = nextTask++; scheduled.set(handle, callback); return handle; },
    cancel(handle) { scheduled.delete(handle); },
  });
  return {
    log, storage, scheduled, time: value => { now = value; },
    runOne() {
      const task = scheduled.entries().next().value;
      if (!task) return;
      const [handle, callback] = task;
      scheduled.delete(handle);
      callback();
    },
  };
}

test('research chunks defer writes at size and arrival thresholds and snapshot mutable data', () => {
  const { log, storage, time, scheduled, runOne } = fixture();
  time(10);
  const meta = { id: 'first', course: { id: 'stretch' } };
  assert.equal(log.start(meta), true);
  meta.course.id = 'modified';
  const sample = { type: 'imu', seq: 999, runId: 'wrong', vector: [1, 2, 3], sensor: { axis: 'x' } };
  log.append(sample);
  sample.vector[0] = 8;
  sample.sensor.axis = 'modified';
  for (let n = 1; n < 99; n++) log.append(row(n));
  assert.equal(storage.getStorageSync(chunkKey('first', 0)), undefined);
  log.append(row(99));
  assert.equal(storage.getStorageSync(chunkKey('first', 0)), undefined, 'threshold append does not write to storage');
  assert.equal(scheduled.size, 1);
  runOne();
  assert.equal(storage.getStorageSync(chunkKey('first', 0)).length, 100);
  time(100);
  log.append(row(100));
  time(2099);
  log.append(row(101));
  assert.equal(storage.getStorageSync(chunkKey('first', 1)), undefined);
  time(2100);
  log.append(row(102));
  assert.equal(storage.getStorageSync(chunkKey('first', 1)), undefined, 'time threshold also queues the write');
  assert.equal(scheduled.size, 1);
  runOne();
  assert.equal(storage.getStorageSync(chunkKey('first', 1)).length, 3);
  const result = { score: 1000, hits: [{ grade: 'perfect' }] };
  assert.equal(log.finish('completed', result), true);
  result.hits[0].grade = 'changed';
  assert.equal(log.active, false);
  assert.equal(log.currentId, 'first');
  assert.equal(log.append(row()), false);
  const exported = readResearchLogs(storage);
  assert.equal(exported.schemaVersion, 1);
  const [run] = exported.runs;
  assert.deepEqual(run.meta, { id: 'first', course: { id: 'stretch' }, schemaVersion: 1, startedAtMs: 10 });
  assert.deepEqual(run.records[0], { type: 'imu', seq: 0, runId: 'first', vector: [1, 2, 3], sensor: { axis: 'x' }, atMs: 10 });
  assert.deepEqual(run.records.map(record => record.seq), Array.from({ length: 104 }, (_, seq) => seq));
  assert.deepEqual(run.records.at(-1), { type: 'end', reason: 'completed', result: { score: 1000, hits: [{ grade: 'perfect' }] }, seq: 103, runId: 'first', atMs: 2100 });
  assert.equal(run.complete, true);
  assert.equal(run.expectedRecords, 104);
});

test('the deferred queue stays bounded and finish cancels its timer and saves every accepted record', () => {
  const { log, storage, scheduled, runOne } = fixture();
  log.start({ id: 'backlog' });
  for (let n = 0; n < 200; n++) assert.equal(log.append(row(n)), true);
  assert.equal(log.append(row(200)), false);
  assert.equal(scheduled.size, 1, 'multiple threshold crossings share a timer');
  assert.equal(storage.getStorageSync(chunkKey('backlog', 0)), undefined);

  runOne();
  assert.equal(storage.getStorageSync(chunkKey('backlog', 0)).length, 100);
  assert.equal(storage.getStorageSync(chunkKey('backlog', 1)), undefined, 'one timer writes one chunk');
  assert.equal(scheduled.size, 1);
  const staleCallback = scheduled.values().next().value;

  assert.equal(log.finish('completed'), true);
  assert.equal(scheduled.size, 0);
  const [run] = readResearchLogs(storage).runs;
  assert.deepEqual(run.records.map(record => record.seq), Array.from({ length: 201 }, (_, seq) => seq));
  assert.equal(run.records.at(-1).type, 'end');
  assert.equal(run.truncatedRecords, 1);
  assert.equal(run.complete, false);

  log.start({ id: 'next' });
  log.append(row(0));
  staleCallback();
  assert.equal(storage.getStorageSync(chunkKey('next', 0)), undefined, 'a canceled callback cannot write a new run');
  log.requestFlush();
  assert.equal(scheduled.size, 1);
  assert.equal(log.flush(), true, 'explicit lifecycle flush persists immediately');
  assert.equal(scheduled.size, 0);
  assert.equal(storage.getStorageSync(chunkKey('next', 0)).length, 1);
});

test('a fresh recorder marks an unfinished persisted run interrupted and evicts only the oldest owned chunks', () => {
  const first = fixture();
  first.storage.setStorageSync('unrelated', { keep: true });
  first.storage.setStorageSync(chunkKey('other', 0), [{ keep: true }]);
  first.log.start({ id: 'a' });
  first.log.append(row());
  first.log.flush();
  const next = fixture(first.storage);
  next.log.start({ id: 'b' });
  let runs = readResearchLogs(next.storage).runs;
  assert.equal(runs[0].status, 'interrupted');
  assert.equal(runs[0].complete, false);
  assert.equal(runs[0].records.length, 1);
  next.log.finish('completed');
  next.log.start({ id: 'c' }); next.log.finish('completed');
  next.log.start({ id: 'd' }); next.log.finish('completed');
  runs = readResearchLogs(next.storage).runs;
  assert.deepEqual(runs.map(run => run.id), ['b', 'c', 'd']);
  assert.deepEqual(next.storage.removed, [chunkKey('a', 0)]);
  assert.deepEqual(next.storage.getStorageSync('unrelated'), { keep: true });
  assert.deepEqual(next.storage.getStorageSync(chunkKey('other', 0)), [{ keep: true }]);
});

test('the per-run cap reserves an end marker and persists the omitted count', () => {
  const { log, storage, runOne } = fixture();
  log.start({ id: 'cap' });
  for (let n = 0; n < 11999; n++) {
    assert.equal(log.append(row(n)), true);
    if (n % 100 === 99) runOne();
  }
  for (let n = 0; n < 17; n++) assert.equal(log.append(row(n)), false);
  assert.equal(log.finish('completed'), true);
  const [run] = readResearchLogs(storage).runs;
  assert.equal(run.expectedRecords, 12000);
  assert.equal(run.records.length, 12000);
  assert.equal(run.records.at(-1).type, 'end');
  assert.equal(run.records.at(-1).seq, 11999);
  assert.equal(run.truncatedRecords, 17);
  assert.equal(run.truncated, true);
  assert.equal(run.complete, false);
  assert.deepEqual(run.gaps, []);
  const [manifest] = storage.getStorageSync(indexKey).runs;
  assert.ok(manifest.chunkSizes.every(size => size <= 100));
});

test('failed chunk writes leave durable sequence gaps and report one notification', () => {
  const storage = memoryStorage(), errors = [];
  const { log, runOne } = fixture(storage, (error, details) => { errors.push([error.message, details]); throw new Error('callback failure'); });
  log.start({ id: 'fails' });
  storage.failWrite = key => key === chunkKey('fails', 0) || key === chunkKey('fails', 1);
  for (let n = 0; n < 200; n++) {
    assert.equal(log.append(row(n)), true);
    if (n % 100 === 99) runOne();
  }
  assert.equal(log.finish('completed'), false);
  assert.equal(log.storageErrors, 2);
  assert.deepEqual(errors, [['write failed', { operation: 'write-chunk', runId: 'fails' }]]);
  const [run] = readResearchLogs(storage).runs;
  assert.equal(run.status, 'finished');
  assert.equal(run.complete, false);
  assert.equal(run.storageErrors, 2);
  assert.deepEqual(run.missingChunks, [0, 1]);
  assert.deepEqual(run.gaps, [{ fromSeq: 0, toSeq: 199 }]);
  assert.deepEqual(run.records.map(record => record.seq), [200]);
});

test('an index write failure leaves no orphan chunk and later writes retain its missing range', () => {
  const { log, storage } = fixture();
  log.start({ id: 'index-failure' });
  log.append(row());
  storage.failWrite = key => key === indexKey;
  assert.equal(log.flush(), false);
  assert.equal(storage.getStorageSync(chunkKey('index-failure', 0)), undefined);
  storage.failWrite = () => false;
  assert.equal(log.finish('completed'), false);
  const [run] = readResearchLogs(storage).runs;
  assert.deepEqual(run.missingChunks, [0]);
  assert.deepEqual(run.gaps, [{ fromSeq: 0, toSeq: 0 }]);
  assert.equal(run.storageErrors, 1);
  assert.equal(run.records[0].type, 'end');
});

test('export preserves surviving ordered rows from partial chunks and reports read failures', () => {
  const { log, storage } = fixture();
  log.start({ id: 'partial' });
  for (let n = 0; n < 3; n++) log.append(row(n));
  log.flush();
  for (let n = 3; n < 5; n++) log.append(row(n));
  log.flush();
  log.finish('completed');
  const [a, , c] = storage.getStorageSync(chunkKey('partial', 0));
  storage.setStorageSync(chunkKey('partial', 0), [c, a]);
  storage.failRead = key => key === chunkKey('partial', 1);
  const exported = readResearchLogs(storage);
  const [run] = exported.runs;
  assert.equal(exported.readErrors, 1);
  assert.equal(run.readErrors, 1);
  assert.deepEqual(run.records.map(record => record.seq), [0, 2, 5]);
  assert.deepEqual(run.truncatedChunks, [0]);
  assert.deepEqual(run.missingChunks, [1]);
  assert.deepEqual(run.gaps, [{ fromSeq: 1, toSeq: 1 }, { fromSeq: 3, toSeq: 4 }]);
  assert.equal(run.complete, false);
});

test('a failed eviction preserves the manifest and the next start retries deletion', () => {
  const { log, storage } = fixture();
  for (const id of ['a', 'b', 'c']) { log.start({ id }); log.finish('completed'); }
  storage.failRemove = key => key === chunkKey('a', 0);
  assert.equal(log.start({ id: 'd' }), false);
  assert.equal(log.active, false);
  assert.deepEqual(readResearchLogs(storage).runs.map(run => run.id), ['a', 'b', 'c']);
  assert.equal(readResearchLogs(storage).runs[0].storageErrors, 1);
  storage.failRemove = () => false;
  assert.equal(log.start({ id: 'd' }), true);
  assert.deepEqual(readResearchLogs(storage).runs.map(run => run.id), ['b', 'c', 'd']);
});

test('a corrupted index is reported and never overwritten by starting a run', () => {
  const { log, storage } = fixture();
  storage.setStorageSync(indexKey, { schemaVersion: 2, runs: [] });
  assert.equal(log.start({ id: 'invalid:id' }), false);
  assert.equal(log.start({ id: 'valid' }), false);
  assert.equal(log.active, false);
  assert.equal(storage.getStorageSync(indexKey).schemaVersion, 2);
  assert.match(readResearchLogs(storage).indexError, /Invalid research index/);
});
