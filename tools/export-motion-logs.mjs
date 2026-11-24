#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const MARKER = '[rhythm-research] ';
const TIMEOUT_MS = 30_000;
const MAX_EVENTS = 40_000;
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RUNS = 3;
const isCount = (value, limit) => Number.isInteger(value) && value >= 0 && value <= limit;
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class MotionLogCollector {
  constructor(expectedExportId = null, { seekBegin = false } = {}) {
    this.expectedExportId = expectedExportId;
    this.seekBegin = seekBegin;
    this.exportId = null;
    this.runCount = 0;
    this.runs = new Map();
    this.events = [];
    this.rawLines = [];
    this.bytes = 0;
    this.complete = false;
  }

  accept(line) {
    const markerIndex = line.indexOf(MARKER);
    if (markerIndex < 0) return;
    const json = line.slice(markerIndex + MARKER.length).trim();
    if (this.expectedExportId && !json.includes(this.expectedExportId)) return;
    let row;
    try { row = JSON.parse(json); }
    catch {
      if (this.seekBegin && !this.exportId) return;
      throw new Error('研究日志中有无法解析的导出记录');
    }
    if (this.expectedExportId && row?.exportId !== this.expectedExportId) return;
    if (this.seekBegin && !this.exportId && row?.kind !== 'begin') return;
    if (!isObject(row) || row.schemaVersion !== 1 || !isId(row.exportId)) {
      throw new Error('研究日志导出格式或版本无效');
    }
    if (this.exportId && row.exportId !== this.exportId) {
      throw new Error('日志中包含多个导出 ID，请提供单次导出的记录');
    }
    if (this.complete) throw new Error('导出结束后又收到记录');
    if (!this.exportId && row.kind !== 'begin') throw new Error('导出缺少开始标记');

    this.bytes += Buffer.byteLength(line) + 1;
    if (this.bytes > MAX_CAPTURE_BYTES) throw new Error('研究日志超出 24 MiB 导出上限');
    switch (row.kind) {
      case 'begin': this.begin(row); break;
      case 'run': this.addRun(row); break;
      case 'event': this.addEvent(row); break;
      case 'end': this.end(row); break;
      default: throw new Error('未知的研究日志记录类型');
    }
    this.rawLines.push(line);
  }

  begin(row) {
    if (this.exportId || !isCount(row.runCount, MAX_RUNS)) throw new Error('导出开始标记或会话数无效');
    this.exportId = row.exportId;
    this.runCount = row.runCount;
  }

  addRun(row) {
    if (!isId(row.runId) || !isCount(row.records, MAX_EVENTS) ||
        this.runs.has(row.runId) || this.runs.size >= this.runCount) {
      throw new Error('研究会话记录无效或重复');
    }
    const { schemaVersion, exportId, kind, ...run } = row;
    this.runs.set(row.runId, { run, received: 0, sequences: new Set(), samples: new Map() });
  }

  addEvent(row) {
    const run = this.runs.get(row.runId), event = row.event;
    if (!run || !isObject(event) || event.runId !== row.runId || !isId(event.type) ||
        !Number.isSafeInteger(event.seq) || event.seq < 0 || run.sequences.has(event.seq)) {
      throw new Error('研究事件无效、重复，或缺少所属会话');
    }
    if (run.received >= run.run.records || this.events.length >= MAX_EVENTS) {
      throw new Error('研究事件数量超过声明值或导出上限');
    }
    run.received++;
    run.sequences.add(event.seq);
    this.events.push({ ...event, exportId: row.exportId });

    if (event.type === 'imu' && event.valid && ['accelerometer', 'gyroscope'].includes(event.sensor) && Number.isFinite(event.arrivalMs)) {
      const sample = run.samples.get(event.sensor) || { count: 0, first: event.arrivalMs, last: event.arrivalMs };
      sample.count++;
      sample.first = Math.min(sample.first, event.arrivalMs);
      sample.last = Math.max(sample.last, event.arrivalMs);
      run.samples.set(event.sensor, sample);
    }
  }

  end(row) {
    if (row.runCount !== this.runCount || row.runCount !== this.runs.size || row.eventCount !== this.events.length ||
        [...this.runs.values()].some(({ run, received }) => run.records !== received)) {
      throw new Error('导出声明的会话或事件数量不匹配，日志可能丢失');
    }
    this.complete = true;
  }

  finish() {
    if (!this.exportId) throw new Error('未找到研究日志导出开始标记');
    if (!this.complete) throw new Error('未收到研究日志导出结束标记，未写入文件');
    const runs = [...this.runs.values()].map(({ run, samples }) => ({
      ...run,
      samples: Object.fromEntries([...samples.entries()].map(([type, sample]) => {
        const spanMs = sample.last - sample.first;
        const effectiveHz = spanMs > 0 ? Math.round((sample.count - 1) * 100_000 / spanMs) / 100 : null;
        return [type, { count: sample.count, arrivalSpanMs: spanMs, effectiveHz }];
      })),
    }));
    return {
      sessions: { schemaVersion: 1, exportId: this.exportId, runCount: runs.length, eventCount: this.events.length, runs },
      events: this.events,
      rawLines: this.rawLines,
    };
  }
}

async function readCapture(input) {
  const info = await stat(input);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error('输入需为不超过 64 MiB 的日志文件');
  const collector = new MotionLogCollector();
  const stream = createReadStream(input, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) collector.accept(line);
    return collector.finish();
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function captureLive(serial, timeoutMs, listen) {
  const exportId = listen ? null : randomUUID();
  const collector = new MotionLogCollector(exportId, { seekBegin: listen });
  const adb = spawn('adb', ['-s', serial, 'logcat', '-T', '1', '-v', 'brief'], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: adb.stdout, crlfDelay: Infinity });
  let launch, startupTimer, timeout;
  let armed = !listen;
  let adbError = '', launchOutput = '';
  const armListener = () => {
    if (armed) return;
    armed = true;
    console.error('正在监听研究日志，请在 AIUI Studio 手动打开 pages/research/index。');
  };
  try {
    return await new Promise((done, fail) => {
      adb.stderr.on('data', data => { adbError = (adbError + data).slice(-2048); });
      adb.on('error', error => fail(new Error(`无法启动 adb logcat：${error.message}`)));
      adb.on('close', (code, signal) => fail(new Error(`adb logcat 已停止（${code ?? signal}）${adbError.trim() ? `：${adbError.trim()}` : ''}`)));
      lines.on('error', fail);
      lines.on('line', line => {
        if (!armed) {
          // -T 1 can replay the device log's last line before streaming.
          if (line && !line.startsWith('---------')) armListener();
          return;
        }
        if (collector.complete) return;
        try {
          collector.accept(line);
          if (collector.complete) done(collector.finish());
        } catch (error) { fail(error); }
      });
      // Establish the live logcat stream before opening the page. The requested
      // export UUID also prevents old device log entries being selected.
      if (!listen) startupTimer = setTimeout(() => {
        const args = ['launch-page', 'src', 'pages/research/index', '--serial', serial, '--params', JSON.stringify({ exportId })];
        launch = spawn('aix', args, { cwd: PROJECT, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const append = data => { launchOutput = (launchOutput + data).slice(-2048); };
        launch.stdout.on('data', append);
        launch.stderr.on('data', append);
        launch.on('error', error => fail(new Error(`无法启动 aix：${error.message}`)));
        launch.on('close', (code, signal) => {
          if (code !== 0) fail(new Error(`AIX 调试页面启动失败（${code ?? signal}）${launchOutput.trim() ? `：${launchOutput.trim()}` : ''}`));
        });
      }, 250);
      timeout = setTimeout(() => fail(new Error(`等待导出结束超过 ${timeoutMs} 毫秒，未写入文件`)), timeoutMs);
    });
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(timeout);
    lines.close();
    if (launch && launch.exitCode === null) launch.kill();
    if (adb.exitCode === null) adb.kill();
  }
}

async function writeExport(directory, { sessions, events, rawLines }) {
  await mkdir(directory, { recursive: true });
  const files = [
    ['events.jsonl', events.length ? `${events.map(event => JSON.stringify(event)).join('\n')}\n` : ''],
    ['sessions.json', `${JSON.stringify(sessions, null, 2)}\n`],
    ['raw.logcat', `${rawLines.join('\n')}\n`],
    ['labels.csv', 'runId,startArrivalMs,endArrivalMs,action,annotator,notes\n'],
  ];
  const created = [];
  try {
    for (const [name, text] of files) {
      const path = resolve(directory, name);
      const file = await open(path, 'wx');
      created.push(path);
      try { await file.writeFile(text, 'utf8'); }
      finally { await file.close(); }
    }
  } catch (error) {
    await Promise.allSettled(created.map(path => unlink(path)));
    throw error;
  }
}

const HELP = `用法：node tools/export-motion-logs.mjs --serial SERIAL --listen [--out DIR] [--timeout-ms 30000]
      node tools/export-motion-logs.mjs --input LOGFILE [--out DIR]

Studio 云端应用用 --listen，只读取 adb logcat。看到提示后手动打开研究日志页。
省略 --listen 会用 aix 打开设备上已有的本地开发 Agent 页面。默认输出到 output/motion-research/<时间>/。`;

async function main(args) {
  const { values } = parseArgs({ args, options: {
    serial: { type: 'string' }, input: { type: 'string' }, out: { type: 'string' },
    listen: { type: 'boolean', default: false },
    'timeout-ms': { type: 'string', default: String(TIMEOUT_MS) }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(HELP); return; }
  if (Boolean(values.serial) === Boolean(values.input)) throw new Error('请指定 --serial 或 --input 其中一项');
  if (values.listen && !values.serial) throw new Error('--listen 需要与 --serial 一起使用');
  if (values.serial && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(values.serial)) throw new Error('--serial 格式无效');
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > TIMEOUT_MS) {
    throw new Error('--timeout-ms 必须为 500 到 30000 之间的整数');
  }
  const result = values.input ? await readCapture(resolve(values.input)) : await captureLive(values.serial, timeoutMs, values.listen);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = values.out ? resolve(values.out) : resolve(PROJECT, 'output/motion-research', timestamp);
  await writeExport(directory, result);
  console.log(`已导出 ${result.sessions.runCount} 局、${result.sessions.eventCount} 条研究记录`);
  console.log(directory);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`导出失败：${error.message}`);
    process.exitCode = 1;
  });
}
