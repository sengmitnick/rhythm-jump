import test from 'node:test';
import assert from 'node:assert/strict';
import { LanResearchLog } from '../src/lib/lan-research-log.js';

const endpoint = 'http://127.0.0.1:8787/log';
const turn = () => new Promise(resolve => setImmediate(resolve));
const row = (seq, type = 'imu') => ({ type, seq });
const ackFor = body => {
  const { exportId, chunk } = JSON.parse(body);
  return { ok: true, exportId, chunk };
};

function fixture({ address = endpoint, addresses = null, useWx = true } = {}) {
  let now = 0;
  const calls = [], errors = [];
  const client = new LanResearchLog({
    endpoint: address, endpoints: addresses, clock: () => now,
    wx: useWx ? { request(options) {
      calls.push({ url: options.url, body: options.data, options,
        reply(statusCode = 200, data = ackFor(options.data)) { options.success({ statusCode, data }); },
        fail() { options.fail({ errMsg: 'offline' }); },
      });
    } } : undefined,
    fetch: (url, options) => new Promise((resolve, reject) => {
      calls.push({ url, body: options.body, options,
        reply(status = 200, data = ackFor(options.body)) { resolve({ status, ok: status >= 200 && status < 300, json: async () => data }); },
        fail() { reject(new Error('offline')); },
      });
    }),
    onError: (error, info) => errors.push({ message: error.message, ...info }),
  });
  return { client, calls, errors, setNow: value => { now = value; } };
}

const packets = calls => calls.map(call => JSON.parse(call.body));

test('blank endpoint does not collect or call either network transport', async () => {
  const { client, calls, setNow } = fixture({ address: '   ' });
  assert.equal(client.start('a'), false);
  assert.equal(client.append(row(1)), false);
  setNow(8000);
  assert.equal(client.sendDue(), null);
  assert.equal(client.flush(), null);
  assert.equal(client.finish(), null);
  await turn();
  assert.equal(calls.length, 0);
});

test('scheduled batches wait four seconds, use native timeout, and do not overlap', async () => {
  const { client, calls, setNow } = fixture();
  assert.equal(client.start('a'), true);
  client.append(row(0));
  setNow(3999);
  assert.equal(client.sendDue(), null);
  setNow(4000);
  const sent = client.sendDue();
  assert.ok(sent);
  assert.equal(client.sendDue(), null);
  await turn();
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.timeout, 6000);
  assert.deepEqual(packets(calls), [{ exportId: 'a', chunk: 0, rows: [row(0)], final: false, droppedRows: 0 }]);
  client.append(row(1));
  setNow(4500);
  calls[0].reply(200, '{"ok":true,"exportId":"a","chunk":0}');
  assert.equal(await sent, true);
  setNow(8499);
  assert.equal(client.sendDue(), null);
  setNow(8500);
  const next = client.sendDue();
  await turn();
  assert.deepEqual(packets(calls)[1], { exportId: 'a', chunk: 1, rows: [row(1)], final: false, droppedRows: 0 });
  calls[1].reply();
  assert.equal(await next, true);
});

test('failure keeps the exact packet and retry cursor until the receiver acknowledges it', async () => {
  const { client, calls, errors, setNow } = fixture({ useWx: false });
  client.start('retry');
  client.append(row(0));
  const first = client.flush();
  await turn();
  calls[0].reply(200, { ok: true });
  assert.equal(await first, false, 'a generic response cannot acknowledge specific rows');
  client.append(row(1));
  assert.equal(client.flush(), null, 'flush cannot bypass retry backoff');
  setNow(4000);
  const second = client.sendDue();
  await turn();
  assert.equal(calls[0].body, calls[1].body);
  calls[1].reply(200, { ok: true, exportId: 'wrong', chunk: 0 });
  assert.equal(await second, false);
  setNow(8000);
  const third = client.sendDue();
  await turn();
  assert.equal(calls[1].body, calls[2].body);
  calls[2].fail();
  assert.equal(await third, false);
  assert.equal(errors.length, 1, 'one diagnostic per consecutive failure streak');
  setNow(12000);
  const fourth = client.sendDue();
  await turn();
  assert.equal(calls[2].body, calls[3].body);
  calls[3].reply();
  assert.equal(await fourth, true);
  await turn();
  assert.deepEqual(packets(calls)[4], { exportId: 'retry', chunk: 1, rows: [row(1)], final: false, droppedRows: 0 });
  calls[4].fail();
  await turn();
  assert.equal(errors.length, 2, 'a renewed outage can report after recovery');
});

test('a network failure retries the same chunk on the alternate LAN endpoint', async () => {
  const local = 'http://receiver.local:8787/log';
  const { client, calls, setNow } = fixture({ address: local, addresses: [local, endpoint] });
  client.start('lan-failover');
  client.append(row(0));
  const first = client.flush();
  await turn();
  assert.equal(calls[0].url, local);
  calls[0].fail();
  assert.equal(await first, false);

  setNow(4000);
  const retry = client.sendDue();
  await turn();
  assert.equal(calls[1].url, endpoint);
  assert.equal(calls[1].body, calls[0].body);
  calls[1].reply();
  assert.equal(await retry, true);
});

test('a late acknowledgement finishes its own run and cannot advance the new run', async () => {
  const { client, calls, setNow } = fixture();
  client.start('old'); client.append(row(0));
  const old = client.flush();
  await turn();
  client.append(row(1, 'end'));
  assert.equal(client.finish(), null);
  assert.equal(client.start('new'), true);
  client.append(row(0));
  calls[0].reply();
  assert.equal(await old, true);
  await turn();
  assert.deepEqual(packets(calls).slice(0, 2).map(({ exportId, chunk, final }) => ({ exportId, chunk, final })), [
    { exportId: 'old', chunk: 0, final: false }, { exportId: 'old', chunk: 1, final: true },
  ]);
  calls[1].reply();
  await turn();
  assert.equal(calls.length, 2);
  setNow(4000);
  const next = client.sendDue();
  await turn();
  assert.deepEqual(packets(calls)[2], { exportId: 'new', chunk: 0, rows: [row(0)], final: false, droppedRows: 0 });
  calls[2].reply();
  assert.equal(await next, true);
});

test('finish drains bounded batches and reserves an end row when sampling reaches the cap', async () => {
  const { client, calls, errors } = fixture();
  client.start('cap');
  for (let seq = 0; seq < 11999; seq++) assert.equal(client.append(row(seq)), true);
  for (let seq = 0; seq < 4; seq++) assert.equal(client.append(row(11999 + seq)), false);
  assert.equal(client.append(row(12003, 'end')), true);
  assert.equal(errors.length, 1);
  const first = client.finish();
  let total = 0;
  for (let chunk = 0; chunk < 24; chunk++) {
    await turn();
    assert.equal(calls.length, chunk + 1);
    const packet = JSON.parse(calls[chunk].body);
    assert.equal(packet.chunk, chunk);
    assert.equal(packet.rows.length, 500);
    assert.equal(packet.final, chunk === 23);
    assert.equal(packet.droppedRows, 4);
    total += packet.rows.length;
    if (chunk === 23) assert.deepEqual(packet.rows.at(-1), row(12003, 'end'));
    calls[chunk].reply();
  }
  assert.equal(total, 12000);
  assert.equal(await first, true);
  await turn();
  assert.equal(calls.length, 24);
  assert.equal(client.sendDue(), null);
});

test('a full offline queue preserves earlier runs and declines additional captures', async () => {
  const { client, calls, errors } = fixture();
  for (let i = 0; i < 3; i++) {
    assert.equal(client.start(`run-${i}`), true);
    client.append(row(i));
    client.finish();
  }
  assert.equal(client.start('overflow'), false);
  assert.equal(client.append(row(4)), false);
  assert.equal(errors[0].reason, 'queue-full');
  for (let i = 0; i < 3; i++) {
    await turn();
    const packet = JSON.parse(calls[i].body);
    assert.equal(packet.exportId, `run-${i}`);
    assert.equal(packet.final, true);
    calls[i].reply();
  }
  await turn();
  assert.equal(client.start('after-drain'), true);
});
