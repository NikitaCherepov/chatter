export type ThemeEffectsPreferences = {
  effectsEnabled: boolean;
  intensity: number;
  soundEnabled: boolean;
  musicEnabled: boolean;
  soundVolume: number;
  musicVolume: number;
};
export const DEFAULT_THEME_EFFECTS: ThemeEffectsPreferences = {
  effectsEnabled: true,
  intensity: 1,
  soundEnabled: false,
  musicEnabled: false,
  soundVolume: 0.35,
  musicVolume: 0.15,
};
export const THEME_EFFECT_FIELDS = {
  themeEffectsEnabled: 'effectsEnabled',
  themeEffectIntensity: 'intensity',
  themeSoundEnabled: 'soundEnabled',
  themeMusicEnabled: 'musicEnabled',
  themeSoundVolume: 'soundVolume',
  themeMusicVolume: 'musicVolume',
} as const;
export function parseThemeEffectsPatch(value: unknown): Partial<ThemeEffectsPreferences> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, boolean | number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_THEME_EFFECTS, key)) return null;
    if (
      typeof DEFAULT_THEME_EFFECTS[key as keyof ThemeEffectsPreferences] === 'boolean'
        ? typeof item !== 'boolean'
        : typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1
    )
      return null;
    result[key] = item;
  }
  return result;
}
export type ThemeAudioState = {
  music: { asset: string | null; status: 'idle' | 'loading' | 'playing' | 'paused' | 'error' };
  activeSounds: number;
  error: string | null;
};
export const IDLE_THEME_AUDIO: ThemeAudioState = {
  music: { asset: null, status: 'idle' },
  activeSounds: 0,
  error: null,
};
export type ThemeAudioAction = {
  type: 'themeAudio';
  action:
    'sound' | 'tone' | 'musicPlay' | 'musicPause' | 'musicResume' | 'musicStop' | 'soundsStop';
  asset?: string;
  volume?: number;
  rate?: number;
  frequency?: number;
  durationMs?: number;
  loop?: boolean;
};
export function parseThemeAudioAction(value: Record<string, unknown>): ThemeAudioAction | null {
  const action = value.action;
  if (
    typeof action !== 'string' ||
    ![
      'sound',
      'tone',
      'musicPlay',
      'musicPause',
      'musicResume',
      'musicStop',
      'soundsStop',
    ].includes(action)
  )
    return null;
  if (
    (action === 'sound' || action === 'musicPlay') &&
    (typeof value.asset !== 'string' ||
      !/^assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(mp3|wav|ogg|m4a|flac)$/.test(
        value.asset,
      ) ||
      value.asset.length > 180)
  )
    return null;
  for (const [key, min, max] of [
    ['volume', 0, 1],
    ['rate', 0.25, 4],
    ['frequency', 40, 4000],
    ['durationMs', 20, 2000],
  ] as const) {
    const item = value[key];
    if (
      item !== undefined &&
      (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max)
    )
      return null;
  }
  if (
    (action === 'tone' && typeof value.frequency !== 'number') ||
    (value.loop !== undefined && typeof value.loop !== 'boolean')
  )
    return null;
  return {
    type: 'themeAudio',
    action: action as ThemeAudioAction['action'],
    ...(value.asset !== undefined ? { asset: value.asset as string } : {}),
    ...(value.volume !== undefined ? { volume: value.volume as number } : {}),
    ...(value.rate !== undefined ? { rate: value.rate as number } : {}),
    ...(value.frequency !== undefined ? { frequency: value.frequency as number } : {}),
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs as number } : {}),
    ...(value.loop !== undefined ? { loop: value.loop as boolean } : {}),
  };
}
