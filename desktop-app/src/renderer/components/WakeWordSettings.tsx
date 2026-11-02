import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Checkbox from './Checkbox';
import { WAKE_WORD_CHOICES, type WakeWordConfig } from '../../main/wakeword-config';
import { getWakeWordConfig, setWakeWordConfig, getWakeWordEnabled, setWakeWordEnabled } from '../lib/wakeWordToggle';
import shared from './SettingsModal.module.scss';
import s from './VoiceSettings.module.scss';
import toggleStyles from './MemoryPopover.module.scss';
export function WakeWordSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(getWakeWordEnabled);
  const [config, setConfig] = useState(getWakeWordConfig);
  useEffect(() => {
    const toggle = (event: Event) => setEnabled((event as CustomEvent<{ enabled: boolean }>).detail.enabled);
    const configure = (event: Event) => setConfig((event as CustomEvent<WakeWordConfig>).detail);
    window.addEventListener('chatter:wakeword-toggle', toggle);
    window.addEventListener('chatter:wakeword-config', configure);
    return () => { window.removeEventListener('chatter:wakeword-toggle', toggle); window.removeEventListener('chatter:wakeword-config', configure); };
  }, []);
  const update = (next: WakeWordConfig) => { setConfig(next); setWakeWordConfig(next); };
  return <section className={s.block}>
    <h3>{t('settings.voice.activation.title')}</h3>
    <div className={s.activationToggle}>
      <span id="wake-word-toggle-label">{t('settings.voice.activation.enabled')}</span>
      <button type="button" role="switch" aria-checked={enabled} aria-labelledby="wake-word-toggle-label"
        className={`${toggleStyles.toggle} ${enabled ? toggleStyles.toggleActive : ''}`}
        onClick={() => setWakeWordEnabled(!enabled)}><span /></button>
    </div>
    <p className={s.hint}>{t('settings.voice.activation.help')}</p>
    <fieldset className={s.activationFields} disabled={!enabled}>
      <legend className={s.srOnly}>{t('settings.voice.activation.options')}</legend>
      {(['name', 'phrase'] as const).map(kind => <div className={s.wordGroup} key={kind}>
        <span className={shared.fieldLabel}>{t(`settings.voice.activation.${kind === 'name' ? 'names' : 'phrases'}`)}</span>
        <div className={s.words}>{WAKE_WORD_CHOICES.filter(word => word.kind === kind).map(word =>
          <Checkbox key={word.id} label={word.label} checked={config.words.includes(word.id)}
            disabled={config.words.length === 1 && config.words.includes(word.id)}
            onChange={checked => update({ ...config, words: checked ? [...config.words, word.id] : config.words.filter(id => id !== word.id) })} />
        )}</div>
      </div>)}
      <label className={shared.fieldLabel} htmlFor="wake-word-sensitivity">{t('settings.voice.activation.sensitivity')}</label>
      <div className={shared.volumeRow}>
        <input id="wake-word-sensitivity" type="range" min={0} max={100} step={5} value={config.sensitivity}
          className={shared.volumeSlider} onChange={event => update({ ...config, sensitivity: Number(event.target.value) })} />
        <span className={shared.volumeValue}>{config.sensitivity}%</span>
      </div>
      <div className={s.scale}><span>{t('settings.voice.activation.strict')}</span><span>{t('settings.voice.activation.sensitive')}</span></div>
      <p className={s.hint}>{t('settings.voice.activation.sensitivityHelp')}</p>
    </fieldset>
  </section>;
}
