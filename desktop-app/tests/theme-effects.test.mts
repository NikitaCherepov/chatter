import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ThemeAudioController } = require('../src/renderer/lib/theme-audio');
const {
  setThemeEffectsPreferences,
  readThemeEffectsPreferences,
} = require('../src/renderer/lib/theme-effects-preferences');
const {
  parseThemeAudioAction,
  parseThemeEffectsPatch,
} = require('../src/main/theme-effects-types');
const values = new Map<string, string>();
Object.assign(globalThis, {
  window: new EventTarget(),
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
class Param {
  value = 0;
  setTargetAtTime(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
}
class Source {
  onended: (() => void) | null = null;
  playbackRate = new Param();
  frequency = new Param();
  buffer: any;
  loop = false;
  started = false;
  offset = 0;
  stopped = false;
  connect() {}
  start(_time = 0, offset = 0) {
    this.started = true;
    this.offset = offset;
  }
  stop() {
    this.stopped = true;
  }
}
class Context {
  currentTime = 0;
  destination = {};
  sources: Source[] = [];
  gains: any[] = [];
  closed = false;
  createGain() {
    const gain = { gain: new Param(), connect() {} };
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createOscillator() {
    return this.createBufferSource();
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
  async decodeAudioData() {
    return { duration: 4, length: 400, numberOfChannels: 1 };
  }
}
test('effect/audio command validation and device preferences', () => {
  assert.equal(parseThemeAudioAction({ action: 'tone', frequency: 5000 }), null);
  assert.equal(parseThemeAudioAction({ action: 'sound', asset: 'assets/../one.wav' }), null);
  assert.equal(parseThemeAudioAction({ action: 'musicPlay', asset: 'https://one.mp3' }), null);
  assert.equal(parseThemeEffectsPatch({ musicVolume: 2 }), null);
  assert.equal(parseThemeEffectsPatch({ unrelated: true }), null);
  assert.equal(readThemeEffectsPreferences().soundEnabled, false);
  setThemeEffectsPreferences({ soundVolume: 0.3, musicVolume: 0.2 });
  assert.equal(readThemeEffectsPreferences().musicVolume, 0.2);
});
test('native audio enforces mute, volume, speech ducking, visibility and theme cleanup', async () => {
  const ctx = new Context(),
    audio = new ThemeAudioController(
      async () => new ArrayBuffer(2),
      () => ctx as any,
    );
  audio.configure('one', { 'assets/a.wav': 'one' });
  audio.setVisible(true);
  await audio.playSound('assets/a.wav');
  assert.equal(ctx.sources.length, 0, 'disabled by default');
  setThemeEffectsPreferences({ soundEnabled: true, musicEnabled: true });
  await audio.playSound('assets/a.wav', 0.4);
  assert.equal(audio.getSnapshot().activeSounds, 1);
  assert.equal(ctx.gains[0].gain.value, 0.3);
  assert.equal(ctx.gains[2].gain.value, 0.4);
  await audio.playMusic('assets/a.wav');
  assert.equal(audio.getSnapshot().music.status, 'playing');
  audio.setSpeech(true);
  assert.ok(Math.abs(ctx.gains[1].gain.value - 0.04) < 1e-9);
  ctx.currentTime = 1.5;
  audio.setVisible(false);
  assert.equal(audio.getSnapshot().music.status, 'paused');
  assert.equal(audio.getSnapshot().activeSounds, 0);
  audio.setVisible(true);
  await tick();
  assert.equal(audio.getSnapshot().music.status, 'playing');
  assert.equal(ctx.sources.at(-1)?.offset, 1.5);
  audio.pauseMusic();
  audio.setVisible(false);
  audio.setVisible(true);
  await tick();
  assert.equal(audio.getSnapshot().music.status, 'paused', 'manual pause survives hiding');
  audio.configure('two', {});
  assert.equal(audio.getSnapshot().music.asset, null);
  assert.ok(ctx.sources.every((source) => source.stopped));
  audio.dispose();
  assert.ok(ctx.closed);
});
test('stop/pause and theme changes cancel in-flight playback', async () => {
  let resolve!: (data: ArrayBuffer) => void;
  const ctx = new Context(),
    audio = new ThemeAudioController(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      () => ctx as any,
    );
  audio.configure('one', { 'assets/a.wav': 'one' });
  audio.setVisible(true);
  const sound = audio.playSound('assets/a.wav');
  await tick();
  audio.stopSounds();
  resolve(new ArrayBuffer(2));
  await sound;
  assert.equal(ctx.sources.length, 0, 'late sound never starts');
  audio.configure('two', { 'assets/b.wav': 'two' });
  const music = audio.playMusic('assets/b.wav');
  await tick();
  audio.pauseMusic();
  resolve(new ArrayBuffer(2));
  await music;
  assert.equal(ctx.sources.length, 0);
  assert.equal(audio.getSnapshot().music.status, 'paused');
  await audio.resumeMusic();
  assert.equal(audio.getSnapshot().music.status, 'playing');
  audio.configure('three', { 'assets/c.wav': 'three' });
  const pending = audio.playMusic('assets/c.wav');
  await tick();
  audio.stopMusic();
  resolve(new ArrayBuffer(2));
  await pending;
  assert.equal(audio.getSnapshot().music.status, 'idle');
  audio.dispose();
});
