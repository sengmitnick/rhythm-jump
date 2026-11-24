const SCHEMA_VERSION = 1;
const INDEX_KEY = 'rhythm-research-index-v1';
const RUN_LIMIT = 3;
const RECORD_LIMIT = 12000;
const CHUNK_LIMIT = 100;
const PENDING_LIMIT = CHUNK_LIMIT * 2;
const FLUSH_INTERVAL_MS = 2000;
const ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const chunkKey = (id, index) => `rhythm-research-v1:${id}:${index}`;
const validId = id => typeof id === 'string' && ID_FORMAT.test(id);
const defaultClock = () => typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now() : Date.now();

// Sensor rows are usually flat. Copy nested JSON values only when present so
// later mutation cannot change an already accepted row or run metadata.
function snapshot(value, ancestors = null) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('BigInt is not a research JSON value');
  if (typeof value !== 'object') return undefined;
  const seen = ancestors || new Set();
  if (seen.has(value)) throw new TypeError('Circular research JSON value');
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = Array.from(value, item => snapshot(item, seen) ?? null);
  } else {
    copy = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const field = snapshot(item, seen);
      if (field !== undefined) copy[key] = field;
    }
  }
  seen.delete(value);
  return copy;
}

function readIndex(storage) {
  const index = storage.getStorageSync(INDEX_KEY);
  if (index === undefined) return [];
  if (index?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(index.runs) || index.runs.length > RUN_LIMIT) {
    throw new Error('Invalid research index');
  }
  const ids = new Set();
  for (const run of index.runs) {
    if (!validId(run?.id) || ids.has(run.id) || run.meta?.id !== run.id ||
        !['active', 'finished', 'interrupted'].includes(run.status) ||
        !Number.isInteger(run.chunks) || run.chunks < 0 || run.chunks > RECORD_LIMIT ||
        !Number.isInteger(run.records) || run.records < 0 || run.records > RECORD_LIMIT ||
        !Number.isInteger(run.storageErrors) || run.storageErrors < 0 ||
        !Number.isInteger(run.truncatedRecords) || run.truncatedRecords < 0 ||
        !Array.isArray(run.chunkSizes) || run.chunkSizes.length !== run.chunks ||
        !run.chunkSizes.every(size => Number.isInteger(size) && size >= 1 && size <= CHUNK_LIMIT) ||
        run.chunkSizes.reduce((sum, size) => sum + size, 0) !== run.records) {
      throw new Error('Invalid research run manifest');
    }
    ids.add(run.id);
  }
  return index.runs;
}

export class ResearchLog {
  constructor({
    storage, clock = defaultClock, onError = () => {},
    schedule = callback => setTimeout(callback, 0), cancel = handle => clearTimeout(handle),
  } = {}) {
    this._storage = storage;
    this._clock = clock;
    this._onError = onError;
    this._schedule = schedule;
    this._cancel = cancel;
    this._flushTask = null;
    this._runs = null;
    this._run = null;
    this._pending = [];
    this._pendingSince = 0;
    this._lastFlush = 0;
    this._seq = 0;
    this._dirty = false;
    this._errorCount = 0;
  }

  get currentId() { return this._run?.id ?? null; }
  get active() { return this._run?.status === 'active'; }
  get storageErrors() { return this._errorCount; }

  _now() {
    try {
      const time = this._clock();
      if (Number.isFinite(time)) return time;
    } catch { /* use the system clock if the supplied clock is unavailable */ }
    return Date.now();
  }

  _report(error, operation, run = this._run) {
    this._errorCount++;
    if (run) {
      run.storageErrors++;
      this._dirty = true;
    }
    if (this._errorCount === 1) {
      try { this._onError(error, { operation, runId: run?.id ?? null }); }
      catch { /* logging must not interrupt gameplay */ }
    }
  }

  _saveIndex() {
    if (!this._dirty) return true;
    try {
      this._storage.setStorageSync(INDEX_KEY, { schemaVersion: SCHEMA_VERSION, runs: this._runs });
      this._dirty = false;
      return true;
    } catch (error) {
      this._report(error, 'write-index');
      return false;
    }
  }

  start(meta) {
    let metadata;
    try { metadata = snapshot(meta); }
    catch { return false; }
    if (!validId(metadata?.id)) return false;
    if (this._runs === null) {
      try { this._runs = readIndex(this._storage); }
      catch (error) { this._report(error, 'read-index'); return false; }
      for (const previous of this._runs) {
        if (previous.status === 'active') {
          previous.status = 'interrupted';
          previous.reason = 'interrupted';
          this._dirty = true;
        }
      }
    }
    if (this._runs.some(run => run.id === metadata.id)) return false;
    if (this.active) this.finish('superseded');
    if (this._runs.length >= RUN_LIMIT) {
      const oldest = this._runs[0];
      try {
        for (let index = 0; index < oldest.chunks; index++) this._storage.removeStorageSync(chunkKey(oldest.id, index));
      } catch (error) {
        // Keep the manifest if eviction is incomplete. Any already removed
        // chunks remain visible as gaps, and a later start can retry cleanup.
        this._report(error, 'remove-chunk', oldest);
        this._saveIndex();
        return false;
      }
      this._runs.shift();
    }
    const now = this._now();
    metadata.schemaVersion = SCHEMA_VERSION;
    if (!Number.isFinite(metadata.startedAtMs)) metadata.startedAtMs = now;
    this._run = {
      id: metadata.id, meta: metadata, chunks: 0, chunkSizes: [], records: 0,
      status: 'active', storageErrors: 0, truncatedRecords: 0,
    };
    this._runs.push(this._run);
    this._pending = [];
    this._seq = 0;
    this._lastFlush = now;
    this._dirty = true;
    this._saveIndex();
    return true;
  }

  _enqueue(row, now) {
    if (!this._pending.length) this._pendingSince = now;
    row.seq = this._seq++;
    row.runId = this.currentId;
    if (!Number.isFinite(row.atMs)) row.atMs = now;
    this._pending.push(row);
  }

  append(event) {
    if (!this.active || typeof event?.type !== 'string' || !event.type) return false;
    const now = this._now();
    // Reserve one row for the end marker even when the sensor stream is capped.
    if (this._seq >= RECORD_LIMIT - 1 || this._pending.length >= PENDING_LIMIT) {
      this._run.truncatedRecords++;
      this._dirty = true;
      if (this._run.truncatedRecords === 1 || now - this._lastFlush >= FLUSH_INTERVAL_MS) this.requestFlush();
      return false;
    }
    let row;
    try { row = snapshot(event); }
    catch { return false; }
    this._enqueue(row, now);
    if (this._pending.length >= CHUNK_LIMIT || now - this._pendingSince >= FLUSH_INTERVAL_MS) this.requestFlush();
    return true;
  }

  requestFlush() {
    if (!this._run || this._flushTask || (!this._pending.length && !this._dirty)) return;
    const task = { handle: null };
    this._flushTask = task;
    try {
      // Save one chunk per turn so an IMU callback only records and queues it.
      task.handle = this._schedule(() => {
        if (this._flushTask !== task) return;
        this._flushTask = null;
        this._flushBatch();
        if (this._pending.length) this.requestFlush();
      });
    } catch (error) {
      this._flushTask = null;
      this._report(error, 'schedule-flush');
    }
  }

  _cancelFlush() {
    const task = this._flushTask;
    this._flushTask = null;
    if (task?.handle != null) this._cancel(task.handle);
  }

  _flushBatch() {
    this._lastFlush = this._now();
    if (!this._pending.length) return this._saveIndex();
    const rows = this._pending.splice(0, CHUNK_LIMIT);
    const index = this._run.chunks++;
    this._run.chunkSizes.push(rows.length);
    this._run.records += rows.length;
    this._dirty = true;
    // Reserve this sequence range before writing its data. An interrupted or
    // failed chunk write then exports a known gap instead of disappearing.
    if (!this._saveIndex()) return false;
    try {
      this._storage.setStorageSync(chunkKey(this.currentId, index), rows);
      return true;
    } catch (error) {
      this._report(error, 'write-chunk');
      this._saveIndex();
      return false;
    }
  }

  flush() {
    if (!this._run) return false;
    this._cancelFlush();
    let saved = this._flushBatch();
    while (this._pending.length) if (!this._flushBatch()) saved = false;
    return saved;
  }

  finish(reason, result = null) {
    if (!this.active) return false;
    const now = this._now();
    const endReason = typeof reason === 'string' && reason ? reason : 'finished';
    let finalResult = null;
    try { finalResult = snapshot(result) ?? null; }
    catch { /* retain the end marker even if the optional result is invalid */ }
    this._cancelFlush();
    // Only mark the manifest finished when its final chunk contains the end row.
    let saved = true;
    while (this._pending.length >= CHUNK_LIMIT) if (!this._flushBatch()) saved = false;
    this._enqueue({ type: 'end', reason: endReason, result: finalResult }, now);
    this._run.status = 'finished';
    this._run.reason = endReason;
    this._run.endedAtMs = now;
    this._dirty = true;
    return this._flushBatch() && saved && this._run.storageErrors === 0;
  }
}

function readRun(storage, run) {
  const records = [], missingChunks = [], truncatedChunks = [];
  let firstSeq = 0, readErrors = 0;
  for (let index = 0; index < run.chunks; index++) {
    const size = run.chunkSizes[index];
    let chunk;
    try { chunk = storage.getStorageSync(chunkKey(run.id, index)); }
    catch { readErrors++; }
    if (!Array.isArray(chunk)) {
      missingChunks.push(index);
    } else {
      const bySeq = new Map();
      for (const row of chunk.slice(0, CHUNK_LIMIT)) {
        if (row?.runId === run.id && Number.isInteger(row.seq) && row.seq >= firstSeq && row.seq < firstSeq + size && typeof row.type === 'string' && row.type) {
          bySeq.set(row.seq, row);
        }
      }
      for (let seq = firstSeq; seq < firstSeq + size; seq++) {
        if (bySeq.has(seq)) records.push(bySeq.get(seq));
      }
      if (bySeq.size !== size || chunk.length !== size) truncatedChunks.push(index);
    }
    firstSeq += size;
  }
  const gaps = [];
  let nextSeq = 0;
  for (const row of records) {
    if (row.seq > nextSeq) gaps.push({ fromSeq: nextSeq, toSeq: row.seq - 1 });
    nextSeq = row.seq + 1;
  }
  if (nextSeq < run.records) gaps.push({ fromSeq: nextSeq, toSeq: run.records - 1 });
  const truncated = run.truncatedRecords > 0 || truncatedChunks.length > 0;
  return {
    id: run.id, meta: run.meta, status: run.status, reason: run.reason, endedAtMs: run.endedAtMs,
    chunks: run.chunks, expectedRecords: run.records, records, missingChunks, truncatedChunks, gaps,
    truncated, truncatedRecords: run.truncatedRecords, storageErrors: run.storageErrors, readErrors,
    complete: run.status === 'finished' && !truncated && !missingChunks.length && !gaps.length && run.storageErrors === 0 && readErrors === 0,
  };
}

export function readResearchLogs(storage) {
  try {
    const runs = readIndex(storage).map(run => readRun(storage, run));
    return { schemaVersion: SCHEMA_VERSION, runs, readErrors: runs.reduce((sum, run) => sum + run.readErrors, 0) };
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, runs: [], readErrors: 1, indexError: String(error) };
  }
}
