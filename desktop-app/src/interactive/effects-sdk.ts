import { useSyncExternalStore } from 'react';
import {
  DEFAULT_THEME_EFFECTS,
  IDLE_THEME_AUDIO,
  type ThemeEffectsPreferences,
  type ThemeAudioState,
} from '../main/theme-effects-types';
type Environment = {
  visible: boolean;
  scopeId?: string;
  preferences?: ThemeEffectsPreferences;
  audio?: ThemeAudioState;
};
const api = () => (window as any).chatter;
let environment: Environment = { visible: true },
  reduced = false,
  started = false;
let snapshot = {
  ...environment,
  preferences: DEFAULT_THEME_EFFECTS,
  audio: IDLE_THEME_AUDIO,
  reducedMotion: false,
};
const listeners = new Set<() => void>();
function update() {
  snapshot = {
    ...environment,
    preferences: environment.preferences ?? DEFAULT_THEME_EFFECTS,
    audio: environment.audio ?? IDLE_THEME_AUDIO,
    reducedMotion: reduced,
  };
  syncThemeEffectsRuntime();
  listeners.forEach((listener) => listener());
}
function start() {
  if (started) return;
  started = true;
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  reduced = media?.matches ?? false;
  media?.addEventListener('change', () => {
    reduced = media.matches;
    update();
  });
  const bridge = api();
  if (bridge?.subscribeThemeEnvironment) {
    environment = bridge.getThemeEnvironment();
    bridge.subscribeThemeEnvironment((value: Environment) => {
      environment = value;
      update();
    });
  }
  update();
}
const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => snapshot;
let runtimeInstalled = false,
  paused = false;
const frames = new Map<number, { callback: FrameRequestCallback; native?: number }>();
let sequence = 0;
let requestNative: typeof requestAnimationFrame, cancelNative: typeof cancelAnimationFrame;
function schedule(id: number, frame: { callback: FrameRequestCallback; native?: number }) {
  frame.native = requestNative((time) => {
    frames.delete(id);
    frame.callback(time);
  });
}
export function syncThemeEffectsRuntime() {
  if (!runtimeInstalled) return;
  const next = !environment.visible;
  if (next !== paused) {
    paused = next;
    for (const [id, frame] of frames) {
      if (paused) {
        if (frame.native !== undefined) cancelNative(frame.native);
        frame.native = undefined;
      } else schedule(id, frame);
    }
    document.documentElement.toggleAttribute('data-theme-paused', paused);
  }
  const gsap = (window as any).ChatterGsap?.gsap;
  if (gsap) {
    if (paused) gsap.ticker.sleep();
    else gsap.ticker.wake();
  }
  document.documentElement.toggleAttribute(
    'data-theme-reduced',
    !snapshot.preferences.effectsEnabled || snapshot.preferences.intensity === 0 || snapshot.reducedMotion,
  );
}
export function installThemeEffectsRuntime() {
  if (!api()?.subscribeThemeEnvironment) return;
  requestNative = window.requestAnimationFrame.bind(window);
  cancelNative = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    const id = ++sequence,
      frame = { callback };
    frames.set(id, frame);
    if (!paused) schedule(id, frame);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const frame = frames.get(id);
    if (frame?.native !== undefined) cancelNative(frame.native);
    frames.delete(id);
  };
  const style = document.createElement('style');
  style.textContent =
    'html[data-theme-paused] *,html[data-theme-paused] *::before,html[data-theme-paused] *::after{animation-play-state:paused!important}html[data-theme-reduced] *,html[data-theme-reduced] *::before,html[data-theme-reduced] *::after{animation-duration:0s!important;transition-duration:0s!important}';
  document.head.append(style);
  runtimeInstalled = true;
  start();
  syncThemeEffectsRuntime();
}
export function assetSource(path: string): string {
  return api()?.assetSource(path) ?? '';
}
export function useThemeEffects() {
  const state = useSyncExternalStore(subscribe, getSnapshot),
    owner = state.scopeId;
  return {
    visible: state.visible,
    enabled: state.preferences.effectsEnabled,
    intensity: state.preferences.intensity,
    reducedMotion: state.reducedMotion,
    active:
      state.visible &&
      state.preferences.effectsEnabled &&
      state.preferences.intensity > 0 &&
      !state.reducedMotion,
    setPreferences: (patch: Partial<ThemeEffectsPreferences>) =>
      owner === snapshot.scopeId && !!api()?.setThemeEffectsPreferences(patch),
  };
}
export function useThemeAudio() {
  const state = useSyncExternalStore(subscribe, getSnapshot),
    owner = state.scopeId;
  const command = (action: string, options: object = {}) =>
    owner === snapshot.scopeId && !!api()?.themeAudio(action, options);
  return {
    soundEnabled: state.preferences.soundEnabled,
    musicEnabled: state.preferences.musicEnabled,
    soundVolume: state.preferences.soundVolume,
    musicVolume: state.preferences.musicVolume,
    activeSounds: state.audio.activeSounds,
    error: state.audio.error,
    setPreferences: (patch: Partial<ThemeEffectsPreferences>) =>
      owner === snapshot.scopeId && !!api()?.setThemeEffectsPreferences(patch),
    play: (asset: string, options: { volume?: number; rate?: number } = {}) =>
      command('sound', { asset, ...options }),
    tone: (frequency = 660, durationMs = 60, volume = 0.3) =>
      command('tone', { frequency, durationMs, volume }),
    stopSounds: () => command('soundsStop'),
    music: {
      ...state.audio.music,
      play: (asset: string, loop = true) => command('musicPlay', { asset, loop }),
      pause: () => command('musicPause'),
      resume: () => command('musicResume'),
      stop: () => command('musicStop'),
    },
  };
}
