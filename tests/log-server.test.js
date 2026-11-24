import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogServer } from '../tools/log-server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rhythm-receiver-'));
  const messages = [];
  const logger = { log: message => messages.push(message), error() {} };
  let server, base;
  const stop = async () => {
    if (!server) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = null;
  };
  const start = async () => {
    server = await createLogServer({ outputDirectory: directory, logger });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return {
    directory,
    messages,
    get base() { return base; },
    restart: async () => { await stop(); await start(); },
    request: (path, options) => fetch(base + path, options),
    post: value => fetch(base + '/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
  };
}

const id = '4a05cad8-5b34-4876-9cf4-107b0130b768';
const batch = (chunk, rows, fields = {}) => ({ exportId: id, chunk, rows, ...fields });

test('ordered chunks survive a restart and repeated requests do not duplicate rows', async t => {
  const { directory, restart, post } = await fixture(t);
  const first = batch(0, [{ type: 'start' }, { type: 'pose', x: 1 }]);
  const outOfOrder = await post(batch(1, [{ type: 'end' }]));
  assert.equal(outOfOrder.status, 409);
  assert.deepEqual(await outOfOrder.json(), { ok: false, error: 'chunk_out_of_order', expectedChunk: 0 });
  const duplicates = await Promise.all([post(first), post(first)]);
  assert.ok(duplicates.every(response => response.status === 200));
  const receipts = await Promise.all(duplicates.map(response => response.json()));
  assert.deepEqual(receipts.map(result => result.duplicate).sort(), [false, true]);
  const run = join(directory, `run-${id}.jsonl`);
  assert.equal(await readFile(run, 'utf8'), '{"type":"start"}\n{"type":"pose","x":1}\n');

  const last = batch(1, [{ type: 'end' }], { final: true, droppedRows: 2 });
  assert.equal((await post(last)).status, 200);
  const journal = JSON.parse(await readFile(join(directory, '.chunks', id, '00001.json'), 'utf8'));
  assert.deepEqual(journal, last);
  // Simulate a crash after the journal write but before visible JSONL was updated.
  await unlink(run);
  await restart();
  const receipt = await post(last);
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { ok: true, exportId: id, chunk: 1, duplicate: true, final: true, droppedRows: 2 });
  assert.equal(await readFile(run, 'utf8'), '{"type":"start"}\n{"type":"pose","x":1}\n{"type":"end"}\n');
  const conflict = await post(batch(0, [{ type: 'start', changed: true }]));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'chunk_conflict');
  const trailing = await post(batch(2, [{ type: 'pose' }]));
  assert.equal(trailing.status, 409);
  assert.equal((await trailing.json()).error, 'run_finished');
});

test('health is read-only and the receiver preserves legacy JSON and existing files', async t => {
  const { directory, request, post } = await fixture(t);
  const legacy = join(directory, 'run-4a05cad8.jsonl');
  await writeFile(legacy, '{"legacy":true}\n');
  const collision = await post({ ...batch(0, [{ type: 'start' }]), exportId: '4a05cad8' });
  assert.equal(collision.status, 409);
  assert.equal((await collision.json()).error, 'run_archive_exists');
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await request('/elsewhere')).status, 404);
  assert.equal((await request('/log')).status, 405);
  assert.equal((await request('/log', { method: 'OPTIONS' })).status, 204);
  assert.equal((await post({ probe: true })).status, 200);
  const files = await readdir(directory);
  assert.equal(await readFile(legacy, 'utf8'), '{"legacy":true}\n');
  assert.equal(await readFile(join(directory, files.find(name => name.endsWith('.json'))), 'utf8'), '{"probe":true}');
  assert.equal((await post({ ...batch(0, []), exportId: 'not a valid id' })).status, 400);
  const invalid = await request('/log', { method: 'POST', body: '{' });
  assert.equal(invalid.status, 400);
});

test('accepts exact receiver paths with proxy formatting and logs unmatched paths without query or body', async t => {
  const { base, directory, messages, request } = await fixture(t);
  assert.equal((await request('/health/?via=proxy')).status, 200);
  const preflight = await request('/log/?via=proxy', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');

  const body = JSON.stringify(batch(0, [{ type: 'start' }], { final: true }));
  const proxy = httpRequest(base, {
    path: `${base}/log/?via=proxy`,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  });
  const pending = once(proxy, 'response');
  proxy.end(body);
  const [ack] = await pending;
  const reply = [];
  for await (const chunk of ack) reply.push(chunk);
  assert.equal(ack.statusCode, 200);
  assert.deepEqual(JSON.parse(Buffer.concat(reply)), { ok: true, exportId: id, chunk: 0, duplicate: false, final: true, droppedRows: 0 });
  assert.equal(await readFile(join(directory, `run-${id}.jsonl`), 'utf8'), '{"type":"start"}\n');

  const unknown = await request('/logs?trace=private-query', { method: 'POST', body: 'private-body' });
  assert.equal(unknown.status, 404);
  assert.equal(messages.at(-1), '[log] unmatched POST "/logs"');
});

test('oversized requests receive 413 without affecting the next request', async t => {
  const { request, post } = await fixture(t);
  const tooLarge = await post({ sample: 'a'.repeat(4 * 1024 * 1024) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, 'body_too_large');
  async function* streamedSample() {
    yield '{"sample":"';
    for (let n = 0; n < 5; n++) yield 'a'.repeat(1024 * 1024);
    yield '"}';
  }
  const streamed = await request('/log', { method: 'POST', body: streamedSample(), duplex: 'half' });
  assert.equal(streamed.status, 413);
  assert.equal((await streamed.json()).error, 'body_too_large');
  assert.equal((await request('/health')).status, 200);
});
