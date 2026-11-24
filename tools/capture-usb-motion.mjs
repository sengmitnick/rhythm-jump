#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { followUsbMotion } from './follow-usb-motion.mjs';

const MARKER = '[rhythm-live] ';
const ENDPOINT = 'http://127.0.0.1:8787/log';
const RUN_ID = /^usb-[a-z0-9][a-z0-9_-]{0,123}$/;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseUsbPacket(line) {
  const marker = line.indexOf(MARKER);
  if (marker < 0) return null;
  let packet;
  try { packet = JSON.parse(line.slice(marker + MARKER.length)); }
  catch { throw new Error('收到截断或损坏的 USB 日志行'); }
  if (!isObject(packet) || typeof packet.exportId !== 'string' || !RUN_ID.test(packet.exportId) ||
      !isCount(packet.chunk) || packet.chunk >= 1024 || !Array.isArray(packet.rows) ||
      packet.rows.length > 12_000 || !packet.rows.every(isObject) ||
      typeof packet.final !== 'boolean' || !isCount(packet.droppedRows)) {
    throw new Error('收到格式无效的 USB 日志包');
  }
  const { exportId, chunk, rows, final, droppedRows } = packet;
  return { exportId, chunk, rows, final, droppedRows };
}

export async function forwardUsbPacket(packet, fetchImpl = fetch, endpoint = ENDPOINT) {
  const body = JSON.stringify(packet);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(4000), redirect: 'error',
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(250 * (attempt + 1));
      continue;
    }
    if (response.status >= 500 && attempt < 2) {
      await response.body?.cancel();
      await sleep(250 * (attempt + 1));
      continue;
    }
    const ack = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = ack?.error ? ` ${ack.error}` : '';
      throw new Error(`接收器 HTTP ${response.status}${detail}`);
    }
    if (ack?.ok !== true || ack.exportId !== packet.exportId || ack.chunk !== packet.chunk) {
      throw new Error('接收器确认与日志包不一致');
    }
    return ack;
  }
}

export async function captureUsbLines(lines, {
  forward = forwardUsbPacket, onRun = () => {}, onError = () => {}, runs = new Map(),
} = {}) {
  let errors = 0;
  const seen = new Set();
  for await (const line of lines) {
    let packet;
    try {
      packet = parseUsbPacket(line);
      if (!packet) continue;
      await forward(packet);
    } catch (error) {
      errors++;
      onError(packet ? `${packet.exportId} 分片 ${packet.chunk} ${error.message}` : error.message);
      continue;
    }
    let run = runs.get(packet.exportId);
    seen.add(packet.exportId);
    if (!run) {
      run = {
        exportId: packet.exportId, lastChunk: -1, rows: 0, final: false, droppedRows: 0,
        began: false, imuRows: 0, judgements: 0, ended: false, endReason: null,
      };
      runs.set(packet.exportId, run);
      onRun(run, 'start');
    }
    if (packet.chunk > run.lastChunk) {
      const hadImu = run.imuRows > 0;
      run.lastChunk = packet.chunk;
      run.rows += packet.rows.length;
      run.final = packet.final;
      run.droppedRows = packet.droppedRows;
      for (const row of packet.rows) {
        if (row.type === 'start') run.began = true;
        if (row.type === 'imu' && row.valid !== false && Array.isArray(row.axes) &&
            row.axes.length === 3 && row.axes.every(Number.isFinite)) run.imuRows++;
        if (row.type === 'judgement') run.judgements++;
        if (row.type === 'end') {
          run.ended = true;
          run.endReason = row.reason || null;
        }
      }
      if (!hadImu && run.imuRows) onRun(run, 'imu');
      if (run.final) onRun(run, 'finish');
    }
  }
  return { runs: [...seen].map(id => runs.get(id)), errors };
}

const HELP = '用法：node tools/capture-usb-motion.mjs --serial SERIAL\n' +
  '自动重连及补读：node tools/capture-usb-motion.mjs --follow [--serial SERIAL]\n' +
  '也可回放已保存的 logcat：node tools/capture-usb-motion.mjs --input FILE';

function reportCapture(run, event, serial) {
  const label = serial ? `${serial} ${run.exportId}` : run.exportId;
  if (event === 'start') console.error(`收到 ${label} 的游戏分包，等待有效 IMU`);
  if (event === 'imu') console.log(`${label} 已确认：有效 IMU 已在 Mac 落盘`);
  if (event === 'finish') {
    const complete = run.began && run.ended && run.imuRows > 0 && run.judgements > 0 && run.droppedRows === 0;
    const status = complete ? '记录收齐' : '收到结束分包，记录不完整';
    console.log(`${label} ${status}，IMU ${run.imuRows} 条，判定 ${run.judgements} 条，设备报告丢弃 ${run.droppedRows} 条` +
      (run.endReason ? `，结束原因 ${run.endReason}` : ''));
  }
}

async function listen({ serial, inputFile, signal, replay = false, runs }) {
  const tail = replay ? [] : ['-T', '1'];
  const adb = serial ? spawn('adb', ['-s', serial, 'logcat', ...tail, '-v', 'brief', '-s', 'Ink'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  }) : null;
  const closed = adb && new Promise(done => {
    adb.once('error', error => done({ error }));
    adb.once('close', (code, signal) => done({ code, signal }));
  });
  let stopped = false;
  const stop = () => { stopped = true; adb.kill(); };
  if (adb) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  const input = adb?.stdout ?? createReadStream(inputFile, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    if (adb) console.error('正在监听眼镜 Ink 日志。接收器确认后逐片落盘，Ctrl-C 停止。');
    const outcome = await captureUsbLines(lines, {
      runs,
      onError: message => console.error(message),
      onRun: (run, event) => reportCapture(run, event, serial),
    });
    for (const run of outcome.runs.filter(run => !run.final)) {
      console.log(`${run.exportId} 暂未结束，本次已落盘 ${run.rows} 条至分片 ${run.lastChunk}`);
    }
    const result = await closed;
    if (result?.error) throw result.error;
    if (result && !stopped && result.code !== 0) throw new Error('ADB 日志连接已断开');
    return outcome;
  } finally {
    if (adb) {
      signal.removeEventListener('abort', stop);
      if (adb.exitCode === null && adb.signalCode === null) adb.kill();
    }
    lines.close();
    input.destroy();
  }
}

async function main() {
  const { values } = parseArgs({
    options: { serial: { type: 'string' }, input: { type: 'string' }, follow: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) { console.log(HELP); return; }
  if ((values.input && (values.serial || values.follow)) || (!values.input && !values.serial && !values.follow)) {
    throw new Error(HELP);
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const { signal } = controller;
  try {
    if (values.follow) {
      const runs = new Map();
      await followUsbMotion({
        signal, serial: values.serial,
        capture: (serial, deviceSignal) => listen({ serial, signal: deviceSignal, replay: true, runs }),
      });
    } else {
      const { errors, runs } = await listen({ serial: values.serial, inputFile: values.input, signal });
      if (!runs.length) console.error('未收到可落盘的游戏日志。');
      if (errors || !runs.length) process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
