import test from 'node:test';
import assert from 'node:assert/strict';
import { TutorialVoice } from '../src/lib/tutorial-voice.js';

function fixture() {
  let time = 0, sequence = 0;
  const timers = new Map(), syntheses = [], players = [];
  const voice = new TutorialVoice({
    synthesis: { synthesize(utterance, { signal }) {
      return new Promise(resolve => syntheses.push({ utterance, signal, resolve }));
    } },
    Utterance: class { constructor(text) { this.text = text; } },
    Player: class {
      constructor(task) {
        this.task = task;
        this.calls = [];
        this.audioPlayer = {
          onCanplay: callback => { this.ready = callback; },
          onEnded: callback => { this.ended = callback; },
          onError: callback => { this.error = callback; },
        };
        players.push(this);
      }
      play() { this.calls.push('play'); }
      stop() { this.calls.push('stop'); }
      destroy() { this.calls.push('destroy'); }
    },
    schedule(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
  });
  return {
    voice, syntheses, players,
    advance(ms) {
      time += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= time) { timers.delete(id); timer.callback(); }
      }
    },
    async complete(index) {
      const task = { state: 'running', finished: Promise.resolve({ duration: 0.6 }), abort() { this.state = 'aborted'; } };
      syntheses[index].resolve(task);
      await Promise.resolve();
      return task;
    },
  };
}

test('tutorial voice speaks once after the Good effect and releases the player on completion', async () => {
  const f = fixture();
  assert.equal(f.voice.retry(), true);
  assert.equal(f.voice.retry(), false);
  assert.equal(f.syntheses[0].utterance.text, '再试一下');
  await f.complete(0);
  const [player] = f.players;
  player.ready();
  f.advance(100);
  assert.deepEqual(player.calls, []);
  f.advance(30);
  player.ready();
  assert.deepEqual(player.calls, ['play']);
  player.ended();
  assert.deepEqual(player.calls, ['play', 'stop', 'destroy']);
  assert.equal(f.voice.retry(), true);
  f.voice.stop();
});

test('hiding aborts pending speech and a stale task cannot disrupt a newer prompt', async () => {
  const f = fixture();
  assert.equal(f.voice.retry(), true);
  f.voice.stop();
  assert.equal(f.syntheses[0].signal.aborted, true);
  assert.equal(f.voice.retry(), true);
  assert.equal((await f.complete(0)).state, 'aborted');
  assert.equal(f.players.length, 0);
  await f.complete(1);
  const [player] = f.players;
  f.advance(130);
  player.ready();
  assert.deepEqual(player.calls, ['play']);
  f.voice.stop();
  assert.deepEqual(player.calls, ['play', 'stop', 'destroy']);
});

test('a slow synthesis expires quietly and missing speech support does not start a request', async () => {
  assert.equal(new TutorialVoice({ synthesis: null }).retry(), false);
  const f = fixture();
  f.voice.retry();
  f.advance(1700);
  assert.equal(f.syntheses[0].signal.aborted, true);
  await f.complete(0);
  assert.equal(f.players.length, 0);
});
