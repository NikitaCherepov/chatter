import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  readThemeEffectsPreferences,
  subscribeThemeEffects,
} from '../lib/theme-effects-preferences';
import { saveAppLocalSetting } from '../lib/app-settings';
import Slider from './Slider';
import rows from './RestrictionsSettings.module.scss';
import switches from './MemoryPopover.module.scss';

export function ThemeEffectsControls() {
  const { t } = useTranslation(),
    prefs = useSyncExternalStore(subscribeThemeEffects, readThemeEffectsPreferences);
  const toggles = [
    ['themeEffectsEnabled', 'effectsEnabled', 'enabled'],
    ['themeSoundEnabled', 'soundEnabled', 'soundEnabled'],
    ['themeMusicEnabled', 'musicEnabled', 'musicEnabled'],
  ] as const;
  const volumes = [
    ['themeEffectIntensity', 'intensity', !prefs.effectsEnabled],
    ['themeSoundVolume', 'soundVolume', !prefs.soundEnabled],
    ['themeMusicVolume', 'musicVolume', !prefs.musicEnabled],
  ] as const;
  return (
    <section className={rows.group}>
      <h3>{t('themeEffects.title')}</h3>
      <p>{t('themeEffects.help')}</p>
      {toggles.map(([field, key, label]) => (
        <div className={rows.row} key={field}>
          <span className={rows.label} id={field}>
            {t('themeEffects.' + label)}
          </span>
          <button
            type="button"
            role="switch"
            aria-labelledby={field}
            aria-checked={prefs[key]}
            className={`${switches.toggle} ${prefs[key] ? switches.toggleActive : ''}`}
            onClick={() => saveAppLocalSetting(field, !prefs[key])}
          >
            <span />
          </button>
        </div>
      ))}
      {volumes.map(([field, key, disabled]) => (
        <Slider
          key={field}
          mode="numeric"
          label={t('themeEffects.' + key)}
          min={0}
          max={1}
          step={0.05}
          value={prefs[key]}
          disabled={disabled}
          formatValue={(value) => Math.round(value * 100) + '%'}
          onChange={(value) => saveAppLocalSetting(field, value ?? 0)}
        />
      ))}
    </section>
  );
}
