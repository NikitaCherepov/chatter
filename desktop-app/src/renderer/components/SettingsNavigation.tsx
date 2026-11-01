import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SETTINGS_GROUPS,
  searchSettings,
  settingsSectionKey,
  type SettingsSection,
  type SettingsSearchEntry,
  type SettingsSearchResult,
} from '../lib/settings-navigation';
import fieldEntries from '../lib/settings-search-entries.json';
import s from './SettingsNavigation.module.scss';

const ICONS: Record<SettingsSection, string> = {
  account: 'M20 21v-2a7 7 0 0 0-14 0v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  memory: 'M5 3h14v18l-7-4-7 4z',
  connections: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  models: 'M7 7h10v10H7z M9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3M20 9h3m-3 6h3 M10 10h4v4h-4z',
  prompt: 'M4 3h16v13H9l-5 5z',
  voice: 'M9 3a3 3 0 0 1 6 0v9a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v4m-4 0h8',
  limits: 'M3 18a9 9 0 1 1 18 0 M12 14l5-5 M5 18h14',
  macros: 'M13 2 4 14h7l-1 8 10-13h-7z',
  runbooks: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  pc: 'M3 3h18v13H3z M12 16v5m-5 0h10',
  browser: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18',
  servers: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01M7 17.5h.01',
  sshkeys: 'M14 10a5 5 0 1 0-3 4L3 22l-2-2 8-8 M5 18l2 2',
  mail: 'M3 4h18v16H3z M3 5l9 7 9-7',
  smart_home: 'M3 10l9-8 9 8v12H3z M9 22v-9h6v9',
  data: 'M21 5c0 2-4 4-9 4S3 7 3 5s4-3 9-3 9 1 9 3 M3 5v14c0 2 4 3 9 3s9-1 9-3V5 M3 12c0 2 4 3 9 3s9-1 9-3',
  restrictions: 'M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M9 12l2 2 4-4',
  billing: 'M3 4h18v16H3z M3 9h18 M7 16h4',
  app: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  admin: 'M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M9 12h6M12 9v6',
  about: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7h.01',
};

function SectionIcon({ section }: { section: SettingsSection }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[section]} />
    </svg>
  );
}

type Props = {
  section: SettingsSection;
  isAdmin: boolean;
  onSelect: (section: SettingsSection, result?: SettingsSearchResult) => void;
};

export function SettingsNavigation({ section, isAdmin, onSelect }: Props) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const results = useMemo(() => {
    const sections = SETTINGS_GROUPS.flatMap((group) => group.sections).map((section) => ({
      section,
      key: settingsSectionKey(section),
    }));
    return searchSettings(
      query,
      [...sections, ...(fieldEntries as SettingsSearchEntry[])],
      (key) => t(key),
      isAdmin
    );
  }, [query, isAdmin, t, i18n.resolvedLanguage]);
  useEffect(() => setSelectedKey(null), [query]);
  useEffect(() => {
    if (searching) return;
    resultsRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [section, searching]);
  const select = (result: SettingsSearchResult) => {
    setSelectedKey(`${result.section}:${result.key}`);
    onSelect(result.section, result);
  };

  return (
    <nav className={s.navigation} aria-label={t('settings.title')}>
      <div className={s.search}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('settings.navigation.search')}
          aria-label={t('settings.navigation.search')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              resultsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
            }
            if (event.key === 'Enter' && results[0]) {
              event.preventDefault();
              select(results[0]);
            }
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label={t('settings.navigation.clear')}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>
      <div className={s.scroll} ref={resultsRef}>
        {searching ? (
          <>
            <div className={s.groupTitle} role="status">
              {t('settings.navigation.results', { count: results.length })}
            </div>
            {results.length ? (
              results.map((result) => (
                <button
                  type="button"
                  key={`${result.section}:${result.key}`}
                  className={`${s.item} ${selectedKey === `${result.section}:${result.key}` && section === result.section ? s.active : ''}`}
                  onClick={() => select(result)}
                >
                  <SectionIcon section={result.section} />
                  <span className={s.result}>
                    <span>{result.title}</span>
                    <small>{result.sectionTitle}</small>
                  </span>
                </button>
              ))
            ) : (
              <div className={s.empty}>{t('settings.navigation.noResults')}</div>
            )}
          </>
        ) : (
          SETTINGS_GROUPS.map((group) => (
            <div className={s.group} key={group.id}>
              <div className={s.groupTitle}>{t(`settings.navigation.groups.${group.id}`)}</div>
              {group.sections
                .filter((id) => id !== 'admin' || isAdmin)
                .map((id) => (
                  <button
                    type="button"
                    key={id}
                    className={`${s.item} ${section === id ? s.active : ''}`}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => onSelect(id)}
                  >
                    <SectionIcon section={id} />
                    <span>{t(settingsSectionKey(id))}</span>
                  </button>
                ))}
            </div>
          ))
        )}
      </div>
    </nav>
  );
}
