import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type * as api from '../lib/api';
import { normalizeSettingsSearch } from '../lib/settings-navigation';
import Checkbox from './Checkbox';
import Slider from './Slider';
import shared from './SettingsModal.module.scss';
import s from './ModelGenerationSettings.module.scss';

const PARAMETERS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05 },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.05 },
  { key: 'top_k', label: 'Top K', min: 1, max: 100, step: 1 },
  { key: 'frequency_penalty', label: 'Frequency penalty', min: -2, max: 2, step: 0.05 },
  { key: 'presence_penalty', label: 'Presence penalty', min: -2, max: 2, step: 0.05 },
  { key: 'repetition_penalty', label: 'Repetition penalty', min: 1, max: 2, step: 0.05 },
  { key: 'max_tokens', label: 'Max tokens', min: 1, max: 65536, step: 1 },
] as const;

type Props = {
  models: api.ModelCatalogEntry[];
  settings: api.ModelSettingsMap;
  loading: boolean;
  savingId: string | null;
  onDraftChange: (id: string, settings: api.ModelSettings) => void;
  onSave: (id: string, settings: api.ModelSettings) => void;
  onReset: (id: string) => void;
};

export function ModelGenerationSettings({ models, settings, loading, savingId, onDraftChange, onSave, onReset }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const tokens = normalizeSettingsSearch(query).split(' ').filter(Boolean);
  const visible = models.filter(model => tokens.every(token => normalizeSettingsSearch(model.name).includes(token)));
  return <>
    <input type="search" className={`${shared.fieldInput} ${s.search}`} value={query}
      placeholder={t('settings.models.search')} aria-label={t('settings.models.search')}
      onChange={event => setQuery(event.target.value)} />
    {loading ? <div className={shared.promptLoading}>{t('common.loading')}</div>
      : models.length === 0 ? <p className={s.hint}>{t('settings.models.empty')}</p>
      : visible.length === 0 ? <p className={s.hint}>{t('settings.models.noResults')}</p>
      : <div className={s.models}>{visible.map(model => {
        const current = settings[model.id] || {};
        const changed = PARAMETERS.filter(param => current[param.key] != null).length;
        // Missing capabilities on older servers are unknown; [] explicitly means none.
        const params = PARAMETERS.filter(param => model.supported_params == null || model.supported_params.includes(param.key));
        const busy = savingId !== null;
        return <details className={s.model} key={model.id}>
          <summary>
            <strong title={model.name}>{model.name}</strong>
            <span className={s.status}>{savingId === model.id ? t('common.savingLower') : changed ? t('settings.models.changed', { count: changed }) : t('settings.models.defaults')}</span>
            <svg className={s.chevron} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          </summary>
          <div className={s.body}>
            {params.length === 0 && <p className={s.hint}>{t('settings.models.noParameters')}</p>}
            {params.map(param => {
              const value = current[param.key] ?? null;
              return <div className={s.parameter} key={param.key}>
                <Checkbox checked={value === null} label={t('settings.reasoning.autoLower')} disabled={busy}
                  onChange={checked => {
                    const updated = { ...current };
                    if (checked) delete updated[param.key];
                    else updated[param.key] = param.min;
                    onDraftChange(model.id, updated);
                    onSave(model.id, updated);
                  }} />
                <Slider mode="numeric" label={param.label} min={param.min} max={param.max} step={param.step}
                  value={value} disabled={busy || value === null}
                  formatValue={number => param.step < 1 ? number.toFixed(2) : String(number)}
                  onChange={number => onDraftChange(model.id, { ...current, [param.key]: number })}
                  onCommit={() => onSave(model.id, current)} />
              </div>;
            })}
            {changed > 0 && <button type="button" className={`${shared.cancelBtn} ${s.reset}`} disabled={busy}
              onClick={() => onReset(model.id)}>{t('settings.models.reset')}</button>}
          </div>
        </details>;
      })}</div>}
  </>;
}
