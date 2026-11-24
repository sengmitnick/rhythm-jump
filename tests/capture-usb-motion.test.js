import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureUsbLines, forwardUsbPacket, parseUsbPacket } from '../tools/capture-usb-motion.mjs';
import { createLogServer } from '../tools/log-server.mjs';

const id = 'usb-motion-abc';
const batch = (chunk, rows, final = false) => ({ exportId: id, chunk, rows, final, droppedRows: 0 });
const logLine = packet => `I/Ink     (1951): ink_script::console: [rhythm-live] ${JSON.stringify(packet)}`;

test('reads only the dedicated Ink log packet and rejects malformed payloads', () => {
  const valid = batch(0, [{ type: 'start', source: 'imu' }]);
  assert.deepEqual(parseUsbPacket(logLine(valid)), valid);
  assert.equal(parseUsbPacket('I/Ink: [rhythm-research] unrelated'), null);
  assert.throws(() => parseUsbPacket('I/Ink: [rhythm-live] {'), /截断/);
  assert.throws(() => parseUsbPacket(logLine({ ...valid, exportId: 'motion-abc' })), /格式无效/);
  assert.throws(() => parseUsbPacket(logLine(batch(0, [null]))), /格式无效/);
});

test('does not accept a success response for another packet', async () => {
  const response = new Response(JSON.stringify({ ok: true, exportId: id, chunk: 5 }));
  await assert.rejects(() => forwardUsbPacket(batch(0, []), async () => response), /确认与日志包不一致/);
});

test('writes verified rows to the normal receiver while a game is still running', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rhythm-usb-test-'));
  const server = await createLogServer({ outputDirectory: directory, logger: { log() {}, error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(directory, { recursive: true, force: true });
  });
  const options = { forward: packet => forwardUsbPacket(packet, fetch, `http://127.0.0.1:${server.address().port}/log`) };
  const first = batch(0, [{ type: 'start', source: 'imu' }, { type: 'imu', axes: [0, 0, 9.8] }]);
  const partial = await captureUsbLines([logLine(first)], options);
  assert.equal(partial.runs[0].final, false);
  assert.equal(partial.runs[0].rows, 2);
  const path = join(directory, `run-${id}.jsonl`);
  assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 2);

  const errors = [];
  const last = batch(1, [{ type: 'end' }], true);
  const done = await captureUsbLines([logLine(first), 'I/Ink: [rhythm-live] {', logLine(last)], {
    ...options, onError: error => errors.push(error),
  });
  assert.deepEqual(errors, ['收到截断或损坏的 USB 日志行']);
  assert.equal(done.runs[0].final, true);
  const records = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(row => row.type), ['start', 'imu', 'end']);
});

test('reports actual IMU only after receiver acknowledgement and deduplicates reconnect replay', async () => {
  const events = [];
  const runs = new Map();
  const options = {
    runs, forward: async () => {},
    onRun: (run, event) => events.push([event, run.imuRows, run.judgements]),
  };
  const start = logLine(batch(0, [{ type: 'start' }, { type: 'imu', valid: false, axes: [0, 0, 0] }]));
  const actual = logLine(batch(1, [{ type: 'imu', valid: true, axes: [0, 0, 9.81] }]));
  const finish = logLine(batch(2, [{ type: 'judgement' }, { type: 'end', reason: 'completed' }], true));
  await captureUsbLines([start], options);
  assert.deepEqual(events, [['start', 0, 0]]);
  await captureUsbLines([actual], { ...options, forward: async () => { throw Error('unavailable'); } });
  assert.deepEqual(events, [['start', 0, 0]]);
  const outcome = await captureUsbLines([start, actual, finish], options);
  assert.deepEqual(events, [['start', 0, 0], ['imu', 1, 0], ['finish', 1, 1]]);
  assert.equal(outcome.runs[0].endReason, 'completed');
  assert.equal(outcome.runs[0].rows, 5);
});
