import {
  IDLE_THEME_AUDIO,
  type ThemeAudioState,
  type ThemeAudioAction,
} from '../../main/theme-effects-types';
import { readThemeEffectsPreferences } from './theme-effects-preferences';

/** Native-owned playback. Theme code receives commands/state, never an unrestricted audio player. */
export class ThemeAudioController {
  private context: AudioContext | undefined;
  private effectsGain: GainNode | undefined;
  private musicGain: GainNode | undefined;
  private listeners = new Set<() => void>();
  private state: ThemeAudioState = IDLE_THEME_AUDIO;
  private assets: Record<string, string> = {};
  private owner = '';
  private epoch = 0;
  private visible = false;
  private speech = false;
  private sounds = new Set<AudioScheduledSourceNode>();
  private soundTimes: number[] = [];
  private soundTicket = 0;
  private cache = new Map<string, Promise<AudioBuffer>>();
  private cacheBytes = 0;
  private music: AudioBufferSourceNode | undefined;
  private musicBuffer: AudioBuffer | undefined;
  private musicOffset = 0;
  private musicStarted = 0;
  private musicIntent = false;
  private musicLoop = true;
  private musicTicket = 0;
  constructor(
    private load: (url: string) => Promise<ArrayBuffer>,
    private factory: () => AudioContext = () => new AudioContext(),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<ThemeAudioState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private init() {
    if (!this.context) {
      this.context = this.factory();
      this.effectsGain = this.context.createGain();
      this.musicGain = this.context.createGain();
      this.effectsGain.connect(this.context.destination);
      this.musicGain.connect(this.context.destination);
    }
    return this.context;
  }
  configure(owner: string, assets: Record<string, string>) {
    const identity = owner + JSON.stringify(assets);
    if (identity === this.owner) return;
    this.stopAll();
    this.epoch++;
    this.owner = identity;
    this.assets = { ...assets };
    this.cache.clear();
    this.cacheBytes = 0;
    this.publish({ ...IDLE_THEME_AUDIO });
  }
  refresh() {
    const prefs = readThemeEffectsPreferences();
    if (!prefs.soundEnabled) this.stopSounds();
    if (!prefs.musicEnabled) this.stopMusic();
    const ctx = this.context;
    if (ctx) {
      this.effectsGain!.gain.setTargetAtTime(prefs.soundVolume, ctx.currentTime, 0.03);
      this.musicGain!.gain.setTargetAtTime(
        prefs.musicVolume * (this.speech ? 0.2 : 1),
        ctx.currentTime,
        0.08,
      );
    }
  }
  setSpeech(active: boolean) {
    this.speech = active;
    this.refresh();
  }
  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.stopSounds();
      this.pauseMusic(true);
    } else if (this.musicIntent && readThemeEffectsPreferences().musicEnabled)
      void this.resumeMusic();
  }
  private permittedSound() {
    const now = Date.now();
    this.soundTimes = this.soundTimes.filter((time) => now - time < 1000);
    if (
      !this.visible ||
      !readThemeEffectsPreferences().soundEnabled ||
      this.sounds.size >= 8 ||
      this.soundTimes.length >= 20
    )
      return false;
    this.soundTimes.push(now);
    return true;
  }
  private async buffer(asset: string) {
    const url = this.assets[asset];
    if (!url || !/^assets\/.+\.(mp3|wav|ogg|m4a|flac)$/.test(asset))
      throw new Error('theme_audio_asset_unavailable');
    if (!this.cache.has(asset)) {
      const epoch = this.epoch,
        ctx = this.init();
      const pending = this.load(url)
        .then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
        .then((buffer) => {
          if (epoch !== this.epoch) throw new Error('theme_audio_scope_changed');
          const bytes = buffer.length * buffer.numberOfChannels * 4;
          if (bytes > 128 * 1024 * 1024) throw new Error('theme_audio_decoded_limit');
          if (this.cacheBytes + bytes > 128 * 1024 * 1024) {
            this.cache.clear();
            this.cacheBytes = 0;
          }
          this.cacheBytes += bytes;
          return buffer;
        })
        .catch((error) => {
          if (this.cache.get(asset) === pending) this.cache.delete(asset);
          throw error;
        });
      this.cache.set(asset, pending);
    }
    return this.cache.get(asset)!;
  }
  private track(source: AudioScheduledSourceNode) {
    this.sounds.add(source);
    this.publish({ activeSounds: this.sounds.size });
    source.onended = () => {
      this.sounds.delete(source);
      this.publish({ activeSounds: this.sounds.size });
    };
  }
  async playSound(asset: string, volume = 1, rate = 1) {
    if (!this.permittedSound()) return;
    const epoch = this.epoch,
      ticket = this.soundTicket;
    try {
      const ctx = this.init();
      await ctx.resume();
      const buffer = await this.buffer(asset);
      if (
        epoch !== this.epoch ||
        ticket !== this.soundTicket ||
        !this.visible ||
        !readThemeEffectsPreferences().soundEnabled
      )
        return;
      if (buffer.duration > 10) throw new Error('theme_sound_too_long');
      if (this.sounds.size >= 8) return;
      this.refresh();
      const source = ctx.createBufferSource(),
        gain = ctx.createGain();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(this.effectsGain!);
      this.track(source);
      source.start();
    } catch (error) {
      if (epoch === this.epoch)
        this.publish({ error: error instanceof Error ? error.message : 'theme_audio_failed' });
    }
  }
  async tone(frequency: number, durationMs = 60, volume = 0.3) {
    if (!this.permittedSound()) return;
    const epoch = this.epoch,
      ticket = this.soundTicket;
    try {
      const ctx = this.init();
      await ctx.resume();
      if (
        epoch !== this.epoch ||
        ticket !== this.soundTicket ||
        !this.visible ||
        !readThemeEffectsPreferences().soundEnabled
      )
        return;
      this.refresh();
      const source = ctx.createOscillator(),
        gain = ctx.createGain(),
        now = ctx.currentTime,
        end = now + durationMs / 1000;
      source.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.008);
      gain.gain.linearRampToValueAtTime(0, end);
      source.connect(gain);
      gain.connect(this.effectsGain!);
      this.track(source);
      source.start(now);
      source.stop(end);
    } catch (error) {
      if (epoch === this.epoch)
        this.publish({ error: error instanceof Error ? error.message : 'theme_audio_failed' });
    }
  }
  async playMusic(asset: string, loop = true) {
    if (!this.visible || !readThemeEffectsPreferences().musicEnabled) return;
    this.stopMusic();
    const epoch = this.epoch,
      ticket = ++this.musicTicket;
    this.musicIntent = true;
    this.musicLoop = loop;
    this.publish({ music: { asset, status: 'loading' }, error: null });
    try {
      const ctx = this.init();
      await ctx.resume();
      const buffer = await this.buffer(asset);
      if (
        epoch !== this.epoch ||
        ticket !== this.musicTicket ||
        !readThemeEffectsPreferences().musicEnabled
      )
        return;
      this.musicBuffer = buffer;
      this.musicOffset = 0;
      if (this.visible && this.musicIntent) await this.resumeMusic();
      else this.publish({ music: { asset, status: 'paused' } });
    } catch (error) {
      if (epoch === this.epoch && ticket === this.musicTicket) {
        this.musicIntent = false;
        this.publish({
          music: { asset, status: 'error' },
          error: error instanceof Error ? error.message : 'theme_audio_failed',
        });
      }
    }
  }
  pauseMusic(hidden = false) {
    if (!hidden) this.musicIntent = false;
    if (!this.music) {
      if (this.state.music.status === 'loading')
        this.publish({ music: { ...this.state.music, status: 'paused' } });
      return;
    }
    this.musicOffset += this.context!.currentTime - this.musicStarted;
    const source = this.music;
    this.music = undefined;
    source.onended = null;
    source.stop();
    this.publish({ music: { ...this.state.music, status: 'paused' } });
  }
  async resumeMusic() {
    if (!this.visible || !readThemeEffectsPreferences().musicEnabled || this.music) return;
    if (!this.musicBuffer) {
      if (this.state.music.asset) await this.playMusic(this.state.music.asset, this.musicLoop);
      return;
    }
    const epoch = this.epoch,
      ticket = this.musicTicket,
      ctx = this.init();
    this.musicIntent = true;
    try {
      await ctx.resume();
      if (
        epoch !== this.epoch ||
        ticket !== this.musicTicket ||
        !this.visible ||
        !this.musicIntent ||
        this.music
      )
        return;
      this.refresh();
      const source = ctx.createBufferSource();
      source.buffer = this.musicBuffer;
      source.loop = this.musicLoop;
      source.connect(this.musicGain!);
      this.music = source;
      this.musicStarted = ctx.currentTime;
      source.onended = () => {
        if (this.music === source) {
          this.music = undefined;
          this.musicIntent = false;
          this.publish({ music: { ...this.state.music, status: 'idle' } });
        }
      };
      source.start(0, this.musicOffset % this.musicBuffer.duration);
      this.publish({ music: { ...this.state.music, status: 'playing' } });
    } catch (error) {
      if (epoch === this.epoch)
        this.publish({ error: error instanceof Error ? error.message : 'theme_audio_failed' });
    }
  }
  stopSounds() {
    this.soundTicket++;
    for (const source of this.sounds) {
      source.onended = null;
      try {
        source.stop();
      } catch {}
    }
    this.sounds.clear();
    if (this.state.activeSounds) this.publish({ activeSounds: 0 });
  }
  stopMusic() {
    this.musicTicket++;
    this.musicIntent = false;
    if (this.music) {
      this.music.onended = null;
      try {
        this.music.stop();
      } catch {}
      this.music = undefined;
    }
    this.musicBuffer = undefined;
    this.musicOffset = 0;
    if (this.state.music.status !== 'idle' || this.state.music.asset)
      this.publish({ music: { asset: null, status: 'idle' } });
  }
  stopAll() {
    this.stopSounds();
    this.stopMusic();
  }
  handle(action: ThemeAudioAction) {
    if (action.action === 'sound') void this.playSound(action.asset!, action.volume, action.rate);
    else if (action.action === 'tone')
      void this.tone(action.frequency!, action.durationMs, action.volume);
    else if (action.action === 'musicPlay') void this.playMusic(action.asset!, action.loop);
    else if (action.action === 'musicPause') this.pauseMusic();
    else if (action.action === 'musicResume') void this.resumeMusic();
    else if (action.action === 'musicStop') this.stopMusic();
    else this.stopSounds();
  }
  dispose() {
    this.epoch++;
    this.stopAll();
    this.cache.clear();
    this.cacheBytes = 0;
    const ctx = this.context;
    this.context = undefined;
    if (ctx) void ctx.close();
    this.listeners.clear();
  }
}
