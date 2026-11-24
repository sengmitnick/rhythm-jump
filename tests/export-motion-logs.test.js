import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MotionLogCollector } from '../tools/export-motion-logs.mjs';

function line(kind, fields = {}, exportId = 'capture-1') {
  return 'D/Ink( 42): [rhythm-research] ' + JSON.stringify({ schemaVersion: 1, exportId, kind, ...fields });
}
function fixture(collector, { end = true, eventCount = 2 } = {}) {
  collector.accept(line('begin', { runCount: 1 }));
  collector.accept('W/OtherProcess( 65): unrelated device text');
  collector.accept(line('run', { runId: 'test-run', records: 2, missingChunks: [1] }));
  collector.accept(line('event', { runId: 'test-run', event: { runId: 'test-run', seq: 0, type: 'imu', sensor: 'accelerometer', valid: true, arrivalMs: 100 } }));
  collector.accept(line('event', { runId: 'test-run', event: { runId: 'test-run', seq: 2, type: 'imu', sensor: 'accelerometer', valid: true, arrivalMs: 120 } }));
  if (end) collector.accept(line('end', { runCount: 1, eventCount }));
}

test('collects one complete export, omits unrelated logs and preserves declared missing chunks', () => {
  const collector = new MotionLogCollector('capture-1');
  collector.accept(line('begin', { runCount: 1 }, 'stale-export'));
  fixture(collector);
  const { sessions, events, rawLines } = collector.finish();
  assert.equal(sessions.runCount, 1);
  assert.equal(sessions.eventCount, 2);
  assert.deepEqual(sessions.runs[0].missingChunks, [1]);
  assert.deepEqual(sessions.runs[0].samples.accelerometer, { count: 2, arrivalSpanMs: 20, effectiveHz: 50 });
  assert.deepEqual(events.map(({ seq, exportId }) => [seq, exportId]), [[0, 'capture-1'], [2, 'capture-1']]);
  assert.equal(rawLines.length, 5);
  assert.ok(rawLines.every(row => row.includes('[rhythm-research]') && !row.includes('stale-export')));
});

test('refuses truncated exports, count mismatches and ambiguous export IDs', () => {
  const truncated = new MotionLogCollector();
  fixture(truncated, { end: false });
  assert.throws(() => truncated.finish(), /结束标记/);
  assert.throws(() => fixture(new MotionLogCollector(), { eventCount: 1 }), /数量不匹配/);
  assert.throws(() => truncated.accept(line('begin', { runCount: 0 }, 'another-capture')), /多个导出 ID/);
});

test('Studio listen mode skips the replayed log line and captures a manual export without launching aix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rhythm-listen-'));
  const output = join(directory, 'output'), aixCall = join(directory, 'aix-called');
  const manualId = 'studio-manual-export';
  const oldLine = line('begin', { runCount: 0 }, 'stale-export');
  const freshLines = [
    line('begin', { runCount: 1 }, manualId),
    line('run', { runId: 'studio-run', records: 1 }, manualId),
    line('event', { runId: 'studio-run', event: { runId: 'studio-run', seq: 0, type: 'end' } }, manualId),
    line('end', { runCount: 1, eventCount: 1 }, manualId),
  ];
  try {
    await writeFile(join(directory, 'adb'), `#!/usr/bin/env node
      if (process.argv.slice(2).join(' ') !== '-s studio-device logcat -T 1 -v brief') process.exit(21);
      console.log(${JSON.stringify(oldLine)});
      setTimeout(() => console.log(${JSON.stringify(freshLines.join('\n'))}), 450);
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    await writeFile(join(directory, 'aix'), `#!/usr/bin/env node
      require('node:fs').writeFileSync(${JSON.stringify(aixCall)}, 'called'); process.exit(22);
    `, { mode: 0o700 });
    const script = fileURLToPath(new URL('../tools/export-motion-logs.mjs', import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, '--serial', 'studio-device', '--listen', '--out', output], {
      timeout: 5000, env: { ...process.env, PATH: [directory, dirname(process.execPath)].join(delimiter) },
    });
    assert.match(stderr, /手动打开/);
    assert.match(stdout, /已导出 1 局、1 条研究记录/);
    await assert.rejects(access(aixCall), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(output, 'sessions.json'), 'utf8')).exportId, manualId);
    assert.doesNotMatch(await readFile(join(output, 'raw.logcat'), 'utf8'), /stale-export/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
