export const CONSOLE_RESEARCH_MARKER = '[rhythm-live] ';

const ID = /^[a-z0-9][a-z0-9_-]{0,123}$/;
const MAX_LINE_BYTES = 2599;
const MAX_PENDING = 256;
const MAX_ROWS = 12000;
const MAX_CHUNKS = 1024;
const SCAN_PER_PACKET = 32;
const INTERVAL_MS = 100;
const FLUSH_PACKETS = 7;

function encodeRow(row) {
  try {
    const json = JSON.stringify(row);
    return json?.startsWith('{') ? json : null;
  } catch {
    return null;
  }
}

export class ConsoleResearchLog {
  constructor({ clock = () => performance.now(), emit = line => console.log(line) } = {}) {
    this._clock = clock;
    this._emit = emit;
    this._encoder = new TextEncoder();
    this._run = null;
  }

  start(id) {
    if (typeof id !== 'string' || !ID.test(id) || this._run?.exportId === `usb-${id}`) return false;
    if (this._run && !this.finish()) return false;
    this._run = {
      exportId: `usb-${id}`, chunk: 0, rows: [], end: null, accepted: 0,
      dropped: 0, closing: false, dueAt: this._clock(),
    };
    return true;
  }

  append(row) {
    const run = this._run;
    if (!run || run.closing || !row || typeof row !== 'object' || Array.isArray(row)) return false;
    // Keep the last event even when the raw sensor queue fills.
    if (row.type === 'end') {
      run.end = row;
      return true;
    }
    if (run.rows.length >= MAX_PENDING || run.accepted >= MAX_ROWS - 1) {
      run.dropped++;
      return false;
    }
    run.rows.push(row);
    run.accepted++;
    return true;
  }

  sendDue(now = this._clock()) {
    const run = this._run;
    if (!run || now < run.dueAt) return false;
    run.dueAt = now + INTERVAL_MS;
    if (run.closing) return this._send(run, true);
    if (!run.rows.length || run.chunk >= MAX_CHUNKS - 1) return false;
    return this._send(run, false);
  }

  flush(now = this._clock()) {
    const run = this._run;
    if (!run || (!run.rows.length && !run.closing)) return false;
    run.dueAt = now;
    return this.sendDue(now);
  }

  finish(now = this._clock()) {
    const run = this._run;
    if (!run) return false;
    run.closing = true;
    run.dueAt = now + INTERVAL_MS;
    for (let index = 0; index < FLUSH_PACKETS && run.rows.length && run.chunk < MAX_CHUNKS - 1; index++) {
      if (!this._send(run, false)) return false;
    }
    return this._send(run, true);
  }

  _send(run, final) {
    const bytes = text => this._encoder.encode(text).length;
    const prefix = `${CONSOLE_RESEARCH_MARKER}{"exportId":"${run.exportId}","chunk":${run.chunk},"rows":[`;
    const suffix = dropped => `],"final":${final},"droppedRows":${dropped}}`;
    const capacity = MAX_LINE_BYTES - prefix.length - suffix(Number.MAX_SAFE_INTEGER).length;
    let used = 0, scanned = 0, dropped = run.dropped;
    let end = final && run.end ? encodeRow(run.end) : null;
    if (final && run.end && (!end || bytes(end) > capacity)) {
      end = '{"type":"end","reason":"record-too-large"}';
      dropped++;
    }
    const endBytes = end ? bytes(end) : 0;
    const rows = [];
    for (const row of run.rows) {
      if (scanned >= SCAN_PER_PACKET) break;
      const json = encodeRow(row);
      const size = json ? bytes(json) : Infinity;
      if (size > capacity) {
        scanned++;
        dropped++;
        continue;
      }
      const comma = rows.length ? 1 : 0;
      if (used + comma + size + (end ? endBytes + 1 : 0) > capacity) break;
      rows.push(json);
      used += comma + size;
      scanned++;
    }
    if (final) dropped += run.rows.length - scanned;
    if (end) rows.push(end);

    if (rows.length || final) {
      try { this._emit(prefix + rows.join(',') + suffix(dropped)); }
      catch { return false; }
      run.chunk++;
    }
    run.dropped = dropped;
    run.rows.splice(0, scanned);
    if (final) this._run = null;
    return true;
  }
}
