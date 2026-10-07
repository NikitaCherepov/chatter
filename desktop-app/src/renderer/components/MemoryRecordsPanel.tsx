import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './MemoryRecordsPanel.module.scss';
const MemoryMap = lazy(() => import('./MemoryMap'));

export type MemoryRecord = {
  id: string;
  memory_space_id: number;
  text: string;
  source: string;
  updated_at: number;
};

type SemanticResult = { groups?: Array<{ record_id: string }> };

export function MemoryRecordsPanel({
  records,
  semanticEndpoint,
  vectorEndpoint,
  semanticBody,
  compact = false,
  emptyLabel,
  onEdit,
  onDelete,
}: {
  records: MemoryRecord[];
  semanticEndpoint: string;
  vectorEndpoint: string;
  semanticBody?: Record<string, unknown>;
  compact?: boolean;
  emptyLabel: string;
  onEdit: (record: MemoryRecord) => void;
  onDelete: (record: MemoryRecord) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'text' | 'semantic'>('text');
  const [semanticIds, setSemanticIds] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [mapOpened, setMapOpened] = useState(false);
  const searchVersion = useRef(0);

  useEffect(() => {
    searchVersion.current++;
    setSemanticIds(null);
    setSearching(false);
    return () => { searchVersion.current++; };
  }, [semanticEndpoint, JSON.stringify(semanticBody), query, mode]);

  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (mode === 'semantic') {
      if (semanticIds === null) return records;
      const byId = new Map(records.map(record => [record.id, record]));
      return semanticIds.map(id => byId.get(id)).filter((record): record is MemoryRecord => Boolean(record));
    }
    if (!normalized) return records;
    return records.filter(record => `${record.source}\n${record.text}`.toLocaleLowerCase().includes(normalized));
  }, [mode, query, records, semanticIds]);

  const runSemanticSearch = async () => {
    const normalized = query.trim();
    if (!normalized || searching) return;
    setSearching(true);
    const version = ++searchVersion.current;
    try {
      const result = await api.apiFetch<SemanticResult>(semanticEndpoint, {
        method: 'POST',
        body: JSON.stringify({ ...semanticBody, query: normalized }),
      });
      if (version === searchVersion.current) setSemanticIds((result.groups || []).map(group => group.record_id));
    } catch {
      if (version === searchVersion.current) toast.error(t('chat.memory.search.failed'));
    } finally {
      if (version === searchVersion.current) setSearching(false);
    }
  };

  return (
    <>
      <div className={s.viewToolbar}>
        <div className={s.modeSwitch} aria-label={t('memoryMap.view')}>
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? s.active : ''} onClick={() => setView('list')}>{t('memoryMap.list')}</button>
          <button type="button" aria-pressed={view === 'map'} className={view === 'map' ? s.active : ''} onClick={() => { setMapOpened(true); setView('map'); }}>{t('memoryMap.map')}</button>
        </div>
      </div>
      <div className={`${s.search} ${compact ? s.compactSearch : ''}`}>
        <div className={s.searchInputWrap}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input
            type="search"
            value={query}
            maxLength={300}
            placeholder={t('chat.memory.search.placeholder')}
            onChange={event => {
              setQuery(event.target.value);
              setSemanticIds(null);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && mode === 'semantic') {
                event.preventDefault();
                void runSemanticSearch();
              }
            }}
          />
        </div>
        <div className={s.searchControls}>
          <div className={s.modeSwitch}>
            <button type="button" className={mode === 'text' ? s.active : ''} onClick={() => setMode('text')}>
              {t('chat.memory.search.text')}
            </button>
            <button type="button" className={mode === 'semantic' ? s.active : ''} onClick={() => setMode('semantic')}>
              {t('chat.memory.search.semantic')}
            </button>
          </div>
          {mode === 'semantic' && (
            <button type="button" className={s.searchButton} disabled={!query.trim() || searching} onClick={() => void runSemanticSearch()}>
              {searching ? t('chat.memory.search.searching') : t('chat.memory.search.action')}
            </button>
          )}
          <span className={s.counter}>{query.length}/300</span>
        </div>
      </div>
      {mapOpened && <Suspense fallback={view === 'map' ? <div className={s.empty}>{t('memoryMap.loading')}</div> : null}>
        <MemoryMap active={view === 'map'} endpoint={vectorEndpoint} records={records}
          matches={query.trim() && (mode === 'text' || semanticIds !== null) ? new Set(visibleRecords.map(record => record.id)) : null}
          compact={compact} onEdit={onEdit} onDelete={onDelete} />
      </Suspense>}
      {view === 'list' && <div className={`${s.records} ${compact ? s.compactRecords : ''}`}>
        {visibleRecords.length === 0 && <div className={s.empty}>{query.trim() ? t('chat.memory.search.noResults') : emptyLabel}</div>}
        {visibleRecords.map(record => (
          <MemoryRecordCard key={record.id} record={record} compact={compact} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>}
    </>
  );
}

export function MemoryRecordCard({
  record,
  compact,
  onEdit,
  onDelete,
}: {
  record: MemoryRecord;
  compact: boolean;
  onEdit: (record: MemoryRecord) => void;
  onDelete: (record: MemoryRecord) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const expandable = record.text.length > (compact ? 130 : 220) || record.text.split('\n').length > 3;
  return (
    <article className={s.record}>
      <button
        type="button"
        className={s.recordBody}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => expandable && setExpanded(value => !value)}
      >
        <span className={s.recordSource}>{record.source}</span>
        <span className={`${s.recordText} ${!expanded && expandable ? s.clamped : ''}`}>{record.text}</span>
        {expandable && (
          <svg className={`${s.chevron} ${expanded ? s.chevronExpanded : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>
        )}
      </button>
      <span className={s.recordActions}>
        <button type="button" onClick={() => onEdit(record)} title={t('common.edit')} aria-label={t('common.edit')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button type="button" className={s.dangerButton} onClick={() => onDelete(record)} title={t('common.delete')} aria-label={t('common.delete')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
        </button>
      </span>
    </article>
  );
}
