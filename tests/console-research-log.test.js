import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleResearchLog, CONSOLE_RESEARCH_MARKER } from '../src/lib/console-research-log.js';

function fixture() {
  let now = 0;
  const packets = [];
  const log = new ConsoleResearchLog({ clock: () => now, emit(line) {
    assert.ok(line.startsWith(CONSOLE_RESEARCH_MARKER));
    assert.ok(Buffer.byteLength(line) < 2600);
    assert.ok(!line.includes('\n'));
    packets.push(JSON.parse(line.slice(CONSOLE_RESEARCH_MARKER.length)));
  } });
  return { log, packets, advance(ms) { now += ms; } };
}

test('console research packets stream during play and close with ordered rows', () => {
  const { log, packets, advance } = fixture();
  assert.equal(log.start('Run!'), false);
  assert.equal(log.start('session-1'), true);
  const start = { type: 'start', message: '左右闪\n起跳' };
  log.append(start);
  log.sendDue();
  assert.deepEqual(packets[0], { exportId: 'usb-session-1', chunk: 0, rows: [start], final: false, droppedRows: 0 });

  for (let frame = 0; frame < 4800; frame++) {
    advance(20);
    log.append({ type: 'imu', axes: [0.12538293648292, 9.775894825784, -0.00189397571298],
      clockMs: frame * 20, elapsedMs: frame * 20, arrivalMs: frame * 20, sensorTimestamp: 14100905000 + frame,
      quat: [0.005798145267, 0.447051482919, 0.000389848454, 0.898745788372], valid: true, mode: 'playing' });
    const before = packets.length;
    log.sendDue();
    log.sendDue();
    assert.ok(packets.length <= before + 1);
  }
  assert.equal(log.append({ type: 'judgement', grade: 'miss' }), true);
  assert.equal(log.append({ type: 'end', reason: 'completed' }), true);
  assert.equal(log.finish(), true);
  const rows = packets.flatMap(packet => packet.rows);
  assert.equal(rows.length, 4803);
  assert.deepEqual(rows.slice(-2), [{ type: 'judgement', grade: 'miss' }, { type: 'end', reason: 'completed' }]);
  assert.ok(packets.every(({ chunk, final, droppedRows }, index) =>
    chunk === index && final === (index === packets.length - 1) && droppedRows === 0));
});

test('oversized rows and a large pending burst report truncation while preserving the end event', () => {
  const { log, packets } = fixture();
  log.start('overload');
  log.append({ type: 'imu', text: '啊'.repeat(2000) });
  for (let seq = 0; seq < 400; seq++) log.append({ seq, text: '好'.repeat(350) });
  log.append({ type: 'end', reason: 'hidden' });
  assert.equal(log.finish(), true);
  assert.ok(packets.length < 10, 'finish remains bounded');
  const rows = packets.flatMap(packet => packet.rows);
  assert.deepEqual(rows.at(-1), { type: 'end', reason: 'hidden' });
  assert.equal(packets.at(-1).droppedRows + rows.length, 402);
  assert.equal(packets.at(-1).final, true);
});

test('the last server chunk slot is reserved for completion', () => {
  const { log, packets, advance } = fixture();
  log.start('long-run');
  for (let seq = 0; seq < 1028; seq++) {
    log.append({ seq, text: 'x'.repeat(2000) });
    log.sendDue();
    advance(100);
  }
  assert.equal(packets.length, 1023);
  log.append({ type: 'end' });
  log.finish();
  assert.equal(packets.length, 1024);
  assert.equal(packets.at(-1).chunk, 1023);
  assert.equal(packets.at(-1).final, true);
  assert.deepEqual(packets.at(-1).rows.at(-1), { type: 'end' });
});

test('an unavailable console does not crash the game or advance the chunk cursor', () => {
  let available = false;
  const lines = [];
  const log = new ConsoleResearchLog({ clock: () => 0, emit(line) {
    if (!available) throw new Error('console unavailable');
    lines.push(line.slice(CONSOLE_RESEARCH_MARKER.length));
  } });
  log.start('no-console');
  log.append({ type: 'chart' });
  assert.equal(log.sendDue(), false);
  assert.equal(log.flush(), false);
  available = true;
  assert.equal(log.flush(), true);
  assert.equal(log.finish(), true);
  assert.deepEqual(lines.map(line => JSON.parse(line).chunk), [0, 1]);
});
