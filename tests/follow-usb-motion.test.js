import assert from 'node:assert/strict';
import test from 'node:test';
import { followUsbMotion, usbGlasses } from '../tools/follow-usb-motion.mjs';

function listing(...devices) {
  return ['List of devices attached', ...devices, ''].join('\n');
}

function glasses(serial, usb = '1-2', transport = 1) {
  return `${serial} device usb:${usb} product:glasses2 model:RG_glasses2 device:glasses2 transport_id:${transport}`;
}

async function follow(listings, { serial, closeFirst = false, failedSetup = false } = {}) {
  const controller = new AbortController();
  const calls = [], starts = [], stops = [], messages = [];
  let poll = -1;
  let active = null;
  await followUsbMotion({
    serial, signal: controller.signal,
    log: message => messages.push(message),
    run: async (program, args, signal) => {
      assert.equal(signal, controller.signal);
      calls.push([program, ...args]);
      if (args[0] === 'devices') return listings[++poll];
      if (failedSetup) throw new Error(program === 'adb' ? 'reverse unavailable' : 'receiver unavailable');
      return program === 'curl' || args[2] === 'shell' ? '{"ok":true}' : '';
    },
    wait: async () => {
      await new Promise(resolve => setImmediate(resolve));
      if (poll === listings.length - 1) controller.abort();
    },
    capture: async (deviceSerial, signal) => {
      assert.equal(active, null);
      starts.push(deviceSerial);
      if (closeFirst && starts.length === 1) return;
      active = deviceSerial;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      stops.push(deviceSerial);
      active = null;
    },
  });
  assert.equal(active, null);
  return { calls, starts, stops, messages };
}

test('ADB discovery identifies online USB Rokid glasses and ignores phones, network mirrors and offline devices', () => {
  assert.deepEqual(usbGlasses(listing(
    glasses('RG-ONE'),
    'RG-TWO device usb:2-1 model:RG_glasses1 transport_id:6',
    'RG-NET:5555 device product:glasses2 model:RG_glasses2 transport_id:3',
    'RG-OFF offline usb:1-3 product:glasses2 model:RG_glasses2',
    'PHONE device usb:1-4 product:shiba model:Pixel_8',
  )), [
    { serial: 'RG-ONE', identity: 'RG-ONE usb:1-2 transport_id:1' },
    { serial: 'RG-TWO', identity: 'RG-TWO usb:2-1 transport_id:6' },
  ]);
});

test('following keeps one stream open, reconnects on USB path change and aborts the last stream', async () => {
  const initial = listing(glasses('RG-ONE'));
  const { calls, starts, stops, messages } = await follow([
    initial, initial, listing(), listing(glasses('RG-ONE', '1-2', 2)),
    listing(glasses('RG-ONE', '1-2', 3)), listing(glasses('RG-ONE', '2-3', 3)),
  ]);
  assert.deepEqual(starts, ['RG-ONE', 'RG-ONE', 'RG-ONE', 'RG-ONE']);
  assert.deepEqual(stops, starts);
  assert.deepEqual(calls.filter(call => call[3] === 'reverse'), Array(4).fill(['adb', '-s', 'RG-ONE', 'reverse', 'tcp:8787', 'tcp:8787']));
  assert.deepEqual(calls.filter(call => call[0] === 'curl').map(call => call.at(-1)), Array(4).fill('http://127.0.0.1:8787/health'));
  assert.deepEqual(calls.filter(call => call[3] === 'shell').map(call => call.at(-1)), Array(4).fill('http://127.0.0.1:8787/health'));
  assert.equal(messages.filter(message => message.includes('已通过 USB 连到 Mac')).length, 4);
});

test('multiple glasses wait for an unambiguous USB choice and an explicit serial never falls back', async () => {
  const first = glasses('RG-ONE');
  const second = glasses('RG-TWO', '1-4', 4);
  const both = listing(first, second);
  const automatic = await follow([both, both, listing(second)]);
  assert.deepEqual(automatic.starts, ['RG-TWO']);
  assert.equal(automatic.messages.filter(message => message.includes('--serial')).length, 1);

  const explicit = await follow([listing(first), both, listing(first)], { serial: 'RG-TWO' });
  assert.deepEqual(explicit.starts, ['RG-TWO']);
  assert.deepEqual(explicit.stops, ['RG-TWO']);
  assert.equal(explicit.calls.some(call => call[2] === 'RG-ONE'), false);
});

test('reverse and receiver failures are separate and a closed logcat stream restarts', async () => {
  const snapshot = listing(glasses('RG-ONE'));
  const { starts, stops, messages } = await follow([snapshot, snapshot], { closeFirst: true, failedSetup: true });
  assert.deepEqual(starts, ['RG-ONE', 'RG-ONE']);
  assert.deepEqual(stops, ['RG-ONE']);
  assert.ok(messages.some(message => message.includes('USB 端口映射失败') && message.includes('reverse unavailable')));
  assert.ok(messages.some(message => message.includes('本地日志接收器检查失败') && message.includes('receiver unavailable')));
  assert.ok(messages.some(message => message.includes('logcat 流已结束')));
});
