import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cancelNewspaperAgentRun,
  cancelNewspaperRun,
  getNewspaperIssue,
  listNewspaperIssues,
  listNewspaperRuns,
  listNewspapers,
  onNewspaperRunEvent,
  startNewspaperRun,
  updateNewspaper,
  type Newspaper,
  type NewspaperIssue,
  type NewspaperIssueSummary,
  type NewspaperRun,
} from '../../lib/api';
import { distributeIssue } from './layout/distributeIssue';
import { NewspaperReader } from './NewspaperReader';
import { distributeBroadsheetIssue } from './templates/BroadsheetTemplate/broadsheetPagination';
import { distributeDeusExIssue } from './templates/DeusExTemplate/deusExPagination';
import { distributeMassEffectIssue } from './templates/MassEffectTemplate/massEffectPagination';
import { distributeWizardingIssue } from './templates/WizardingTemplate/wizardingPagination';
import type { NewspaperVisualStyle } from './types';
import s from './NewspaperTool.module.scss';

const STYLE_KEY = 'chatter:newspaper-preview-style';
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const STYLE_LABELS: Record<Exclude<NewspaperVisualStyle, 'editorial'>, string> = {
  wizarding: 'Волшебная',
  broadsheet: 'Chatter Times',
  deusEx: 'Deus Ex',
  massEffect: 'Mass Effect',
};

const readStyle = (): Exclude<NewspaperVisualStyle, 'editorial'> => {
  const value = localStorage.getItem(STYLE_KEY);
  return value === 'wizarding' || value === 'broadsheet' || value === 'deusEx' || value === 'massEffect'
    ? value
    : 'wizarding';
};

const formatDate = (timestamp: number) => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
}).format(new Date(timestamp * 1000));

const runStatus = (run: NewspaperRun) => {
  if (run.status === 'queued') return 'Редактор ожидает запуска';
  if (run.status === 'running') return run.phase || 'Редактор работает';
  if (run.status === 'ready') return 'Выпуск готов';
  if (run.status === 'cancelled') return 'Остановлено';
  return run.error || 'Не удалось создать выпуск';
};

export function NewspaperTool() {
  const [newspaper, setNewspaper] = useState<Newspaper | null>(null);
  const [issues, setIssues] = useState<NewspaperIssueSummary[]>([]);
  const [run, setRun] = useState<NewspaperRun | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<NewspaperIssue | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [style, setStyle] = useState<Exclude<NewspaperVisualStyle, 'editorial'>>(readStyle);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interests, setInterests] = useState('');
  const [preferences, setPreferences] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const refreshIssues = useCallback(async (newspaperId: number) => {
    const response = await listNewspaperIssues(newspaperId);
    setIssues(response.issues);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await listNewspapers();
        const current = response.newspapers[0] || null;
        if (!alive) return;
        setNewspaper(current);
        if (!current) return;
        setInterests(current.interests);
        setPreferences(current.preferences);
        setStyle(current.style);
        localStorage.setItem(STYLE_KEY, current.style);
        const [issueResponse, runResponse] = await Promise.all([
          listNewspaperIssues(current.id),
          listNewspaperRuns(current.id),
        ]);
        if (!alive) return;
        setIssues(issueResponse.issues);
        setRun(runResponse.runs[0] || null);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить газету');
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => onNewspaperRunEvent((nextRun) => {
    if (newspaper && nextRun.newspaper_id !== newspaper.id) return;
    setRun(nextRun);
    if (nextRun.status === 'ready' && newspaper) void refreshIssues(newspaper.id);
  }), [newspaper, refreshIssues]);

  const pages = useMemo(() => {
    if (!selectedIssue) return [];
    if (style === 'wizarding') return distributeWizardingIssue(selectedIssue);
    if (style === 'broadsheet') return distributeBroadsheetIssue(selectedIssue);
    if (style === 'deusEx') return distributeDeusExIssue(selectedIssue);
    if (style === 'massEffect') return distributeMassEffectIssue(selectedIssue);
    return distributeIssue(selectedIssue, style);
  }, [selectedIssue, style]);

  useEffect(() => {
    setPageIndex(index => Math.max(0, Math.min(index, pages.length - 1)));
  }, [pages.length]);

  const changeStyle = (next: NewspaperVisualStyle) => {
    if (next === 'editorial') return;
    setStyle(next);
    setPageIndex(0);
    localStorage.setItem(STYLE_KEY, next);
    if (newspaper) {
      setNewspaper({ ...newspaper, style: next });
      void updateNewspaper(newspaper.id, { style: next }).catch(() => undefined);
    }
  };

  const saveSettings = async () => {
    if (!newspaper) return;
    setError('');
    try {
      const response = await updateNewspaper(newspaper.id, { interests, preferences, style });
      setNewspaper(response.newspaper);
      setSettingsOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройки');
    }
  };

  const createIssue = async () => {
    if (!newspaper || (run && ACTIVE_STATUSES.has(run.status))) return;
    setError('');
    try {
      const saved = await updateNewspaper(newspaper.id, { interests, preferences, style });
      setNewspaper(saved.newspaper);
      const response = await startNewspaperRun(newspaper.id);
      setRun(response.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось запустить редактора');
    }
  };

  const openIssue = async (summary: NewspaperIssueSummary) => {
    setError('');
    try {
      const response = await getNewspaperIssue(summary.id);
      setSelectedIssue(response.issue);
      setPageIndex(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть выпуск');
    }
  };

  const stopRun = async () => {
    if (!run) return;
    try {
      const response = await cancelNewspaperRun(run.id);
      setRun(response.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось остановить редактора');
    }
  };

  const stopAgent = async (agentId: number) => {
    if (!run) return;
    try {
      await cancelNewspaperAgentRun(run.id, agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось остановить исследователя');
    }
  };

  const active = !!run && ACTIVE_STATUSES.has(run.status);

  return <div className={s.root}>
    <div className={s.toolbar}>
      <div><strong>Ваши газеты</strong><span>Персональный выпуск от редактора и исследователей</span></div>
      <div className={s.toolbarActions}>
        <button type="button" className={s.secondaryButton} onClick={() => setSettingsOpen(value => !value)}>Настроить</button>
        <button type="button" onClick={createIssue} disabled={!newspaper || active}>Создать</button>
      </div>
    </div>

    <div className={s.scroll}>
      {settingsOpen && <section className={s.settings}>
        <label>Интересы<textarea value={interests} onChange={event => setInterests(event.target.value)} placeholder="AI, космос, игры, наука…" /></label>
        <label>Предпочтения<textarea value={preferences} onChange={event => setPreferences(event.target.value)} placeholder="Например: без политики, меньше слухов…" /></label>
        <div className={s.settingsActions}>
          <button type="button" className={s.secondaryButton} onClick={() => setSettingsOpen(false)}>Отмена</button>
          <button type="button" onClick={saveSettings}>Сохранить</button>
        </div>
      </section>}

      {error && <div className={s.error}>{error}</div>}

      {run && <section className={`${s.run} ${s[run.status] || ''}`}>
        <header>
          <div><strong>{runStatus(run)}</strong><span>Запуск #{run.id}</span></div>
          {active && <button type="button" className={s.stopButton} onClick={stopRun}>Остановить всё</button>}
        </header>
        {run.agents.length > 0 && <div className={s.agents}>
          {run.agents.map(agent => <div className={s.agent} key={agent.id}>
            <div><strong>{agent.agent_type === 'news_researcher' ? 'Исследователь' : agent.agent_type}</strong><span>{agent.task}</span></div>
            <em>{agent.status}</em>
            {agent.status === 'running' && <button type="button" onClick={() => stopAgent(agent.id)}>Стоп</button>}
          </div>)}
        </div>}
        {(run.draft != null || run.editor_trace != null || run.agents.length > 0) && <details className={s.json}>
          <summary>JSON и журнал редактора</summary>
          <pre>{JSON.stringify({ draft: run.draft, editor_trace: run.editor_trace, agents: run.agents }, null, 2)}</pre>
        </details>}
      </section>}

      {busy ? <div className={s.empty}><span>Загружаю выпуски…</span></div> : newspaper && <section className={s.newspaper}>
        <header>
          <div><strong>{newspaper.name}</strong><span>{STYLE_LABELS[style]}</span></div>
          <span className={s.style}>{issues.length} вып.</span>
        </header>
        {issues.length > 0 ? <div className={s.issueList}>
          {issues.map(issue => <div className={s.issueRow} key={issue.id}>
            <button type="button" className={s.issue} onClick={() => openIssue(issue)}>
              <div className={s.issueNumber}>№{issue.issue_number}</div>
              <div className={s.issueInfo}><strong>{issue.title}</strong><span>{formatDate(issue.published_at)} · {issue.blocks_count} блоков</span></div>
              <span className={s.openArrow}>↗</span>
            </button>
          </div>)}
        </div> : <div className={s.empty}><div className={s.emptyIcon}>N</div><strong>Выпусков пока нет</strong><span>Настройте интересы и запустите редактора.</span></div>}
      </section>}
    </div>

    <NewspaperReader
      issue={selectedIssue ? pages[pageIndex] || null : null}
      style={style}
      pageNumber={pageIndex + 1}
      pageCount={pages.length}
      canGoPrevious={pageIndex > 0}
      canGoNext={pageIndex < pages.length - 1}
      onPrevious={() => setPageIndex(index => Math.max(0, index - 1))}
      onNext={() => setPageIndex(index => Math.min(pages.length - 1, index + 1))}
      onClose={() => setSelectedIssue(null)}
      onStyleChange={changeStyle}
      previousLabel="Предыдущая страница"
      nextLabel="Следующая страница"
      closeLabel="Закрыть"
    />
  </div>;
}
