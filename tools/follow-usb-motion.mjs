import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PORT = 'tcp:8787';
const HEALTH = 'http://127.0.0.1:8787/health';
const GLASSES = /^(?:product:glasses\d*|model:RG_glasses\d*)(?:_[\w-]+)?$/i;

async function runCommand(program, args, signal) {
  const { stdout } = await exec(program, args, { signal, timeout: 4000 });
  return stdout;
}

function waitForPoll(ms, signal) {
  return sleep(ms, undefined, { signal });
}

export function usbGlasses(output) {
  const glasses = [];
  for (const line of output.split(/\r?\n/)) {
    const [serial, status, ...attributes] = line.trim().split(/\s+/);
    const usbPath = attributes.find(value => value.startsWith('usb:') && value.length > 4);
    if (status !== 'device' || !usbPath || !attributes.some(value => GLASSES.test(value))) continue;
    const transport = attributes.find(value => value.startsWith('transport_id:')) || '';
    glasses.push({ serial, identity: `${serial} ${usbPath} ${transport}` });
  }
  return glasses;
}

function reason(error) {
  return error?.stderr?.trim() || error?.message || String(error);
}

async function prepare(device, run, signal, log) {
  let mapped = false;
  const [usb, host] = await Promise.allSettled([
    (async () => {
      await run('adb', ['-s', device.serial, 'reverse', PORT, PORT], signal);
      mapped = true;
      const body = await run('adb', ['-s', device.serial, 'shell', 'curl', '-fsS',
        '--max-time', '3', '--noproxy', '127.0.0.1', HEALTH], signal);
      if (JSON.parse(body)?.ok !== true) throw new Error('眼镜未收到健康确认');
    })(),
    (async () => {
      const body = await run('curl', ['-fsS', '--max-time', '3', '--noproxy', '*', HEALTH], signal);
      if (JSON.parse(body)?.ok !== true) throw new Error('Mac 未收到健康确认');
    })(),
  ]);
  if (signal?.aborted) return;
  if (usb.status === 'fulfilled') log(`眼镜 ${device.serial} 已通过 USB 连到 Mac 接收器`);
  else log(`${mapped ? '眼镜 USB 端口检查失败' : 'USB 端口映射失败'}：${reason(usb.reason)}。继续通过 logcat 抓取。`);
  if (host.status === 'rejected') log(`本地日志接收器检查失败：${reason(host.reason)}。`);
}

function startCapture(device, capture, log) {
  const controller = new AbortController();
  const stream = { device, controller, ended: false, done: null };
  stream.done = Promise.resolve()
    .then(() => capture(device.serial, controller.signal))
    .then(() => {
      if (!controller.signal.aborted) log(`眼镜 ${device.serial} 的 logcat 流已结束，等待重连。`);
    }, error => {
      if (!controller.signal.aborted) log(`眼镜 ${device.serial} 的 logcat 流出错：${reason(error)}`);
    })
    .finally(() => { stream.ended = true; });
  return stream;
}

async function stopCapture(stream) {
  if (!stream) return;
  stream.controller.abort();
  await stream.done;
}

// The capture callback must resolve or reject when its signal is aborted.
// Wait for it to finish draining before starting another stream for the same log buffer.
export async function followUsbMotion({
  capture, signal, serial, log = console.error,
  run = runCommand, wait = waitForPoll, pollMs = 1000,
}) {
  let stream = null, lastStatus = null;
  const status = message => {
    if (message && message !== lastStatus) log(message);
    lastStatus = message;
  };
  try {
    while (!signal?.aborted) {
      let devices;
      try {
        devices = usbGlasses(await run('adb', ['devices', '-l'], signal));
      } catch (error) {
        if (signal?.aborted) break;
        status(`USB 设备查询失败：${reason(error)}。正在重试。`);
        await wait(pollMs, signal);
        continue;
      }
      if (signal?.aborted) break;
      const eligible = serial ? devices.filter(device => device.serial === serial) : devices;
      const device = eligible.length === 1 ? eligible[0] : null;
      if (stream && (stream.device.identity !== device?.identity || stream.ended)) {
        await stopCapture(stream);
        stream = null;
      }
      if (signal?.aborted) break;

      if (!device) {
        if (eligible.length > 1) status('检测到多副 USB 眼镜，请用 --serial 指定一副。等待连接。');
        else status(serial ? `等待指定眼镜 ${serial} 通过 USB 上线。` : '等待 Rokid 眼镜通过 USB 上线。');
      } else {
        status(null);
        if (!stream) {
          log(`开始监听眼镜 ${device.serial} 的游戏日志。`);
          stream = startCapture(device, capture, log);
          await prepare(device, run, signal, log);
        }
      }
      await wait(pollMs, signal);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    await stopCapture(stream);
  }
}
