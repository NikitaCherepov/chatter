import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AvatarImage } from './AvatarImage';
import { resolveImageUrl } from '../lib/api';
import { normalizeSettingsSearch } from '../lib/settings-navigation';
import type { PromptOption } from './PromptSelector';
import shared from './SettingsModal.module.scss';
import s from './PromptCatalog.module.scss';

type CatalogPrompt = PromptOption & { image_url?: string | null };
export function PromptCatalog({ options, value, onChange, disabled = false }: {
  options: CatalogPrompt[];
  value: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const id = useId();
  const tokens = normalizeSettingsSearch(query).split(' ').filter(Boolean);
  const filtered = options.filter(prompt => tokens.every(token => normalizeSettingsSearch(`${prompt.name} ${prompt.description}`).includes(token)));
  const creating = value === -1;
  return <div className={`${s.catalog} ${s.sidebarCatalog}`}>
    <div className={s.toolbar}>
      <input type="search" className={shared.fieldInput} value={query} placeholder={t('settings.prompt.catalog.search')}
        aria-label={t('settings.prompt.catalog.search')} onChange={event => setQuery(event.target.value)} />
      <button className={shared.saveBtn} type="button" disabled={disabled} aria-pressed={creating} onClick={() => onChange(-1)}>
        + {t('settings.prompt.catalog.create')}
      </button>
    </div>
    <div className={s.list} aria-label={t('settings.sections.prompt')}>
      {(['default', 'custom'] as const).map(kind => {
        const prompts = filtered.filter(prompt => prompt.kind === kind);
        if (!prompts.length) return null;
        return <section className={s.group} key={kind} aria-labelledby={`${id}-${kind}`}>
          <h4 id={`${id}-${kind}`}>{t(kind === 'default' ? 'settings.prompt.catalog.builtIn' : 'promptSelector.myPrompts')}<span>{prompts.length}</span></h4>
          <div className={s.rows}>{prompts.map(prompt => <button type="button" key={prompt.id} className={`${s.row} ${value === prompt.id ? s.active : ''}`}
            aria-pressed={value === prompt.id} disabled={disabled} onClick={() => onChange(prompt.id)}>
            <span className={s.rowAvatar}>{avatar(prompt)}</span>
            <span className={s.rowText}><strong>{prompt.name}</strong>{prompt.description && <small>{prompt.description}</small>}</span>
            {value === prompt.id && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>}
          </button>)}</div>
        </section>;
      })}
      {filtered.length === 0 && <p className={s.empty} role="status">{t('common.nothingFound')}</p>}
    </div>
  </div>;
}

const avatar = (prompt?: CatalogPrompt) => prompt?.image_url
    ? <AvatarImage src={resolveImageUrl(prompt.image_url, 128)} />
    : <span className={s.initial} aria-hidden="true">{Array.from(prompt?.name.trim() || '+')[0].toLocaleUpperCase()}</span>;

export function PromptSelection({ options, value }: { options: CatalogPrompt[]; value: number | null }) {
  const { t } = useTranslation();
  const selected = options.find(prompt => prompt.id === value);
  const creating = value === -1;
  return <>
    {(selected || creating) && <section className={s.selected} aria-label={t('settings.prompt.style')}>
      <span className={s.heroAvatar}>{avatar(selected)}</span>
      <div className={s.heroText}>
        <span className={s.caption}>{t(creating ? 'settings.prompt.catalog.draft' : 'settings.prompt.style')}</span>
        <h3>{selected?.name || t('settings.prompt.new')}</h3>
        {(selected?.description || creating) && <p>{selected?.description || t('settings.prompt.catalog.newHelp')}</p>}
      </div>
    </section>}
  </>;
}
