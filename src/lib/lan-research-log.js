const BATCH_MS = 4000;
const RETRY_MS = 4000;
const REQUEST_TIMEOUT_MS = 6000;
const ROWS_PER_BATCH = 500;
const ROWS_PER_RUN = 12000;
const RETAINED_RUNS = 3;
const EXPORT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const HEADERS = { 'content-type': 'application/json' };

function requestWithWx(wx, endpoint, body) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: endpoint, method: 'POST', header: HEADERS, data: body,
      dataType: 'json', responseType: 'text', timeout: REQUEST_TIMEOUT_MS,
      success: response => resolve({ status: response.statusCode, data: response.data }),
      fail: error => reject(new Error(error?.errMsg || 'LAN request failed')),
    });
  });
}

async function requestWithFetch(fetch, endpoint, body) {
  const response = await fetch(endpoint, { method: 'POST', headers: HEADERS, body });
  return { status: response.status, data: response.ok ? await response.json() : null };
}

function validateAck(response, exportId, chunk) {
  if (!(response.status >= 200 && response.status < 300)) throw new Error(`LAN receiver HTTP ${response.status ?? '?'}`);
  const ack = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  if (ack?.ok !== true || ack.exportId !== exportId || ack.chunk !== chunk) {
    throw new Error('LAN receiver did not acknowledge this chunk');
  }
}

export class LanResearchLog {
  constructor({ endpoint = '', endpoints = null, wx, fetch, clock = () => performance.now(), onError = () => {}, onAck = () => {} } = {}) {
    // The receiver's address changes with the DHCP lease, so several candidates
    // are tried in turn; a failing one moves to the back of the queue.
    const list = (Array.isArray(endpoints) ? endpoints : [])
      .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
    if (typeof endpoint === 'string' && endpoint.trim() && !list.includes(endpoint.trim())) list.unshift(endpoint.trim());
    this._endpoints = list.length ? list : (typeof endpoint === 'string' && endpoint.trim() ? [endpoint.trim()] : []);
    this._endpointIndex = 0;
    this._post = typeof wx?.request === 'function' ? body => requestWithWx(wx, this._currentEndpoint(), body)
      : typeof fetch === 'function' ? body => requestWithFetch(fetch, this._currentEndpoint(), body) : null;
    this._clock = clock;
    this._onError = onError;
    this._onAck = onAck;
    this._runs = [];
    this._active = null;
    this._inFlight = null;
  }

  _currentEndpoint() { return this._endpoints[this._endpointIndex] || ''; }

  get _endpoint() { return this._currentEndpoint(); }

  _rotateEndpoint() {
    if (this._endpoints.length > 1) this._endpointIndex = (this._endpointIndex + 1) % this._endpoints.length;
  }

  start(exportId) {
    if (!this._endpoints.length || typeof exportId !== 'string' || !EXPORT_ID.test(exportId)) return false;
    if (this._runs.some(run => run.id === exportId)) return false;
    if (this._active) this.finish();
    if (this._runs.length >= RETAINED_RUNS) {
      this._report(new Error('LAN research queue is full'), { id: exportId, chunk: 0 }, 'queue-full');
      return false;
    }
    const run = {
      id: exportId, rows: [], accepted: 0, dropped: 0, chunk: 0, packet: null,
      closing: false, drain: false, failed: false,
      dueAt: this._clock() + BATCH_MS, retryAt: -Infinity,
    };
    this._runs.push(run);
    this._active = run;
    return true;
  }

  append(row) {
    const run = this._active;
    if (!run || !row || typeof row !== 'object') return false;
    // Reserve a slot for the closing trace event at the research row cap.
    const limit = row.type === 'end' ? ROWS_PER_RUN : ROWS_PER_RUN - 1;
    if (run.accepted >= limit) {
      run.dropped++;
      if (run.dropped === 1) this._report(new Error('LAN research row limit reached'), run, 'row-limit');
      return false;
    }
    // Trace producers hand over their event record. Freeze its wire representation
    // once the batch is selected so retries cannot contain different rows.
    run.rows.push(row);
    run.accepted++;
    return true;
  }

  sendDue(now = this._clock()) {
    if (!this._endpoint || this._inFlight) return null;
    const run = this._runs.find(candidate => now >= candidate.retryAt && now >= candidate.dueAt &&
      (candidate.packet || candidate.rows.length || candidate.closing));
    if (!run) return null;
    // Enter the transport after setting the lock. This also accommodates wx
    // hosts or test doubles that invoke a callback synchronously.
    const sending = Promise.resolve().then(() => this._send(run));
    this._inFlight = sending;
    return sending;
  }

  flush(now = this._clock()) {
    if (this._active) {
      this._active.drain = true;
      this._active.dueAt = now;
    }
    return this.sendDue(now);
  }

  finish(now = this._clock()) {
    const run = this._active;
    if (run) {
      this._active = null;
      run.closing = true;
      run.drain = true;
      run.dueAt = now;
    }
    return this.sendDue(now);
  }

  _report(error, run, reason) {
    try { this._onError(error, { exportId: run.id, chunk: run.chunk, reason }); }
    catch { /* A logging callback must not interrupt the game. */ }
  }

  async _send(run) {
    let success = false;
    try {
      if (!this._post) throw new Error('LAN transport is unavailable');
      if (!run.packet) {
        const rows = run.rows.slice(0, ROWS_PER_BATCH);
        const final = run.closing && rows.length === run.rows.length;
        const body = JSON.stringify({ exportId: run.id, chunk: run.chunk, rows, final, droppedRows: run.dropped });
        run.packet = { body, count: rows.length, final };
      }
      const packet = run.packet;
      const endpoint = this._endpoint;
      try { validateAck(await this._post(packet.body), run.id, run.chunk); }
      catch (error) { this._rotateEndpoint(); throw error; }
      if (run.chunk === 0 || packet.final) {
        try { this._onAck({ endpoint, exportId: run.id, chunk: run.chunk, rows: packet.count, final: packet.final }); }
        catch { /* A logging callback must not interrupt acknowledgement. */ }
      }
      run.rows.splice(0, packet.count);
      run.chunk++;
      run.packet = null;
      run.failed = false;
      run.retryAt = -Infinity;
      if (packet.final) this._runs.splice(this._runs.indexOf(run), 1);
      const now = this._clock();
      const drain = run.closing || run.drain;
      run.dueAt = now + (drain ? 0 : BATCH_MS);
      // A pause flush drains the currently available rows. Subsequent rows
      // use normal cadence once the flush is caught up.
      if (!run.closing && !run.rows.length) {
        run.drain = false;
        run.dueAt = now + BATCH_MS;
      }
      success = true;
    } catch (error) {
      run.retryAt = this._clock() + RETRY_MS;
      if (!run.failed) this._report(error, run, 'request');
      run.failed = true;
    } finally {
      this._inFlight = null;
    }
    // A finishing or paused page may stop drawing while this request is in
    // flight. Continue ready work after an ack, with no background timer.
    if (success) this.sendDue();
    return success;
  }
}
