import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { memoryPageUrl, useMemoryKey, type MemoryPage } from '../lib/memory-queries';
import s from './MemoryRecordsPanel.module.scss';
const MemoryMap = lazy(() => import('./MemoryMap'));

export type MemoryRecord = { id: string; memory_space_id: number; text: string; source: string; updated_at: number };
type SemanticResult = { groups?: Array<{ record_id: string }>; records?: MemoryRecord[] };

export function MemoryRecordsPanel({
  recordsEndpoint, semanticEndpoint, semanticBody, compact = false, emptyLabel, onEdit, onDelete,
}: {
  recordsEndpoint: string; semanticEndpoint: string; semanticBody?: Record<string, unknown>;
  compact?: boolean; emptyLabel: string;
  onEdit: (record: MemoryRecord) => void; onDelete: (record: MemoryRecord) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mode, setMode] = useState<'text' | 'semantic'>('text');
  const [submitted, setSubmitted] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [mapOpened, setMapOpened] = useState(false);
  const [page, setPage] = useState(0);
  const key = useMemoryKey(recordsEndpoint);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => setPage(0), [debounced, mode, recordsEndpoint]);
  const pages = useQuery({
    queryKey: [...key, 'records', mode === 'text' ? debounced : '', page],
    queryFn: ({ signal }) => api.apiFetch<MemoryPage>(memoryPageUrl(recordsEndpoint, { limit: 50, offset: page * 50, query: mode === 'text' ? debounced : '' }), { signal }),
    enabled: Boolean(recordsEndpoint) && view === 'list' && !(mode === 'semantic' && submitted),
    staleTime: 60_000, gcTime: 300_000,
  });
  const semantic = useQuery({
    queryKey: [...key, 'search', semanticBody ?? {}, submitted],
    queryFn: ({ signal }) => api.apiFetch<SemanticResult>(semanticEndpoint, { method: 'POST', body: JSON.stringify({ ...semanticBody, query: submitted }), signal }),
    enabled: mode === 'semantic' && Boolean(submitted),
    staleTime: 60_000, gcTime: 300_000,
  });
  useEffect(() => { if (pages.isError || semantic.isError) toast.error(t('chat.memory.search.failed')); }, [pages.isError, semantic.isError, t]);
  const visibleRecords = useMemo(() => mode === 'semantic' && submitted
    ? semantic.data?.records ?? []
    : pages.data?.records ?? [], [mode, submitted, semantic.data, pages.data]);
  const pageCount = Math.ceil((pages.data?.total ?? 0) / 50);
  useEffect(() => { if (pages.data && !pages.isFetching) setPage(value => Math.min(value, Math.max(0, pageCount - 1))); }, [pages.data, pages.isFetching, pageCount]);
  const pageNumbers = [...new Set([0, pageCount - 1, page - 2, page - 1, page, page + 1, page + 2])].filter(value => value >= 0 && value < pageCount).sort((a, b) => a - b);
  const searching = semantic.isFetching;
  const runSemanticSearch = () => { if (query.trim()) { if (submitted === query.trim()) void semantic.refetch(); else setSubmitted(query.trim()); } };
  const semanticIds = mode === 'semantic' && submitted && semantic.data ? new Set((semantic.data.groups ?? []).map(group => group.record_id)) : null;
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
              setSubmitted('');
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
            <button type="button" className={mode === 'text' ? s.active : ''} onClick={() => (setMode('text'), setSubmitted(''))}>
              {t('chat.memory.search.text')}
            </button>
            <button type="button" className={mode === 'semantic' ? s.active : ''} onClick={() => (setMode('semantic'), setSubmitted(''))}>
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
        <MemoryMap active={view === 'map'} endpoint={recordsEndpoint}
          matches={semanticIds} textQuery={mode === 'text' ? query.trim() : ''}
          compact={compact} onEdit={onEdit} onDelete={onDelete} />
      </Suspense>}
      {view === 'list' && <div className={`${s.records} ${compact ? s.compactRecords : ''}`}>
        {(pages.isFetching || searching) && <div className={s.mapHint}>{t('memoryMap.loading')}</div>}
        {visibleRecords.length === 0 && !pages.isFetching && !searching && <div className={s.empty}>{query.trim() ? t('chat.memory.search.noResults') : emptyLabel}</div>}
        {visibleRecords.map(record => (
          <MemoryRecordCard key={record.id} record={record} compact={compact} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>}
      {view === 'list' && !(mode === 'semantic' && submitted) && <div className={s.mapToolbar}>
        <span>{t('memoryMap.listCount', { shown: visibleRecords.length, total: pages.data?.total ?? 0 })}</span>
        {pageCount > 1 && <nav className={s.modeSwitch} aria-label={t('memoryMap.pages')}>
          {pageNumbers.map((number, index) => <span key={number}>
            {index > 0 && number - pageNumbers[index - 1] > 1 && <span>…</span>}
            <button type="button" className={page === number ? s.active : ''} aria-current={page === number ? 'page' : undefined} onClick={() => setPage(number)}>{number + 1}</button>
          </span>)}
        </nav>}
        {pages.isError && <button className={s.searchButton} onClick={() => void pages.refetch()}>{t('memoryMap.retry')}</button>}
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
