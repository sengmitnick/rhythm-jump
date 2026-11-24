import test from 'node:test';
import assert from 'node:assert/strict';
import { RhythmAudio } from '../src/lib/audio.js';
import { getCourse } from '../src/lib/courses.js';
import { createTutorialCourse } from '../src/lib/tutorial.js';

// Native host retains graph nodes until the context closes and does not dispatch
// browser onended callbacks. A full course must still fit its finite graph.
class BoundedContext {
  constructor(){this.currentTime=0;this.state='running';this.destination={};this.nodes=0;this.audible=false;}
  node(){if(++this.nodes>16)throw new Error('audio graph capacity exceeded');return {connect(){},disconnect(){},start(){},stop(){}};}
  createOscillator(){return {...this.node(),frequency:{value:0,setValueAtTime(){}},type:'sine'};}
  createGain(){const c=this;return {...this.node(),gain:{value:0,cancelScheduledValues(){},setValueAtTime(v){if(v>0)c.audible=true;},exponentialRampToValueAtTime(){}}};}
  async resume(){this.state='running';}async suspend(){this.state='suspended';}async close(){this.state='closed';}
}
test('long songs and hit sounds stay within a finite native audio graph without onended',async()=>{
  const audio=new RhythmAudio(BoundedContext);await audio.prepare();
  for(let beat=0;beat<1000;beat++){audio.context.currentTime=beat*.5;audio.tick(beat*500,120,32);audio.feedback('perfect');}
  assert.equal(audio.context.audible,true);
  await audio.suspend();await audio.prepare();await audio.close();assert.equal(audio.context,null);
});

test('perfect hits sound immediately with a sharper attack than good hits', () => {
  const audio = new RhythmAudio(null);
  const tones = [];
  audio.tone = (frequency, duration, type, volume, when) => tones.push({ frequency, duration, type, volume, when });

  audio.feedback('perfect', 8);
  assert.equal(tones.length, 2);
  const [attack, body] = tones.splice(0);
  assert.equal(attack.when, undefined);
  assert.equal(body.when, undefined);
  assert.ok(attack.frequency > body.frequency && attack.duration < body.duration);
  assert.ok(body.duration <= 0.08);

  audio.feedback('good', 8);
  assert.equal(tones.length, 1);
  const [good] = tones;
  assert.ok(good.volume < attack.volume && good.frequency < attack.frequency);
});

class StubPlayer {
  constructor() { this.calls = []; }
  onEnded(callback) { this.ended = callback; }
  onError(callback) { this.error = callback; }
  seek(seconds) { this.calls.push(['seek', seconds]); }
  play() { this.calls.push(['play']); }
  stop() { this.calls.push(['stop']); }
  destroy() { this.calls.push(['destroy']); }
}

test('song previews switch immediately, end at the excerpt length and yield to gameplay', async () => {
  const audio = new RhythmAudio(BoundedContext, StubPlayer);
  const beatucada = getCourse('beatucada'), dream = getCourse('into-my-dream');
  assert.equal(audio.startPreview(beatucada), true);
  const first = audio.preview.player;
  assert.equal(first.src, beatucada.previewMusic);
  assert.equal(first.loop, false);
  assert.deepEqual(first.calls, [['play']]);
  assert.equal(audio.previewState().playing, true);

  assert.equal(audio.startPreview(dream), true);
  assert.deepEqual(first.calls.slice(-2), [['stop'], ['destroy']]);
  assert.equal(audio.preview.player.src, dream.previewMusic);
  const next = audio.preview.player;
  audio.preview.startedAt -= dream.previewDurationMs;
  assert.deepEqual(audio.previewState(), { playing: false, progress: 0 });
  assert.deepEqual(next.calls.slice(-2), [['stop'], ['destroy']]);

  assert.equal(audio.startPreview(dream), true);
  const last = audio.preview.player;
  audio.setCourse(dream);
  assert.deepEqual(last.calls.slice(-2), [['stop'], ['destroy']]);
  await audio.prepare();
  audio.startMusic();
  assert.equal(audio.player.src, dream.music);
  assert.deepEqual(audio.player.calls, [['seek', 0], ['play']]);
  const recording = audio.player;
  assert.equal(audio.startPreview(beatucada), true);
  assert.equal(audio.player, null);
  assert.deepEqual(recording.calls.slice(-2), [['stop'], ['destroy']]);
  const ended = audio.preview.player;
  ended.ended();
  assert.equal(audio.preview, null);
  assert.deepEqual(ended.calls.slice(-2), [['stop'], ['destroy']]);

  assert.equal(audio.startPreview(dream), true);
  const failed = audio.preview.player;
  ended.error();
  assert.equal(audio.preview.player, failed);
  failed.error();
  assert.equal(audio.preview, null);
  assert.deepEqual(failed.calls.slice(-2), [['stop'], ['destroy']]);
  assert.equal(new RhythmAudio(null).startPreview(beatucada), false);
  await audio.close();
});

test('tutorial preparation and resume need no decoder, then a formal song resumes at its offset', async () => {
  const audio = new RhythmAudio(BoundedContext, StubPlayer);
  const tutorial = createTutorialCourse();
  audio.setCourse(tutorial);
  await audio.prepare();
  const { context } = audio;
  audio.startMusic();
  assert.equal(audio.player, null);
  await audio.suspend();
  await audio.prepare();
  assert.equal(audio.player, null);

  const formal = getCourse('beatucada');
  audio.setCourse(formal);
  await audio.prepare();
  assert.equal(audio.context, context);
  assert.equal(context.nodes, 12);
  assert.equal(audio.player.loop, false);
  assert.equal(audio.player.src, formal.music);
  const firstPlayer = audio.player;
  audio.startMusic();
  audio.stopMusic();
  audio.stopMusic();
  assert.deepEqual(firstPlayer.calls, [['seek', 0], ['play'], ['stop'], ['destroy']]);
  await audio.prepare();
  assert.notEqual(audio.player, firstPlayer);
  audio.startMusic(42500);
  assert.deepEqual(audio.player.calls, [['seek', 42.5], ['play']]);
  const formalPlayer = audio.player;
  await audio.close();
  assert.deepEqual(formalPlayer.calls.slice(-2), [['stop'], ['destroy']]);
});

test('late recording failures cannot destroy a replacement player', async () => {
  class DeferredPlayer extends StubPlayer {
    play() {
      super.play();
      return new Promise((resolve, reject) => { this.rejectPlayback = reject; });
    }
  }
  const audio = new RhythmAudio(BoundedContext, DeferredPlayer);
  audio.setCourse(getCourse('beatucada'));
  await audio.prepare();
  const discarded = audio.player;
  audio.startMusic();
  audio.stopMusic();
  await audio.prepare();
  const active = audio.player;
  audio.startMusic();

  discarded.rejectPlayback(new Error('Late rejection'));
  discarded.error();
  await Promise.resolve();
  assert.equal(audio.player, active);
  assert.deepEqual(discarded.calls.slice(-2), [['stop'], ['destroy']]);

  active.rejectPlayback(new Error('Recording unavailable'));
  await Promise.resolve();
  assert.equal(audio.player, null);
  assert.deepEqual(active.calls.slice(-2), [['stop'], ['destroy']]);
  audio.tick(0, 120);
  assert.equal(audio.context.audible, true);
  await audio.close();
});

test('native recording failures fall back to synth without changing the chart clock', async () => {
  class UnavailablePlayer { constructor() { throw new Error('AudioPlayer unavailable'); } }
  class PlaybackFailure extends StubPlayer { play() { throw new Error('Recording unavailable'); } }
  for (const Player of [UnavailablePlayer, PlaybackFailure]) {
    const audio = new RhythmAudio(BoundedContext, Player);
    audio.setCourse(getCourse('beatucada'));
    await audio.prepare();
    audio.context.currentTime = -1;
    assert.ok(audio.now() >= 0);
    audio.startMusic();
    assert.equal(audio.player, null);
    assert.ok(audio.now() >= 0);
    audio.context.currentTime = 0;
    audio.tick(0, 120);
    assert.equal(audio.context.audible, true);
    await audio.close();
  }
});
