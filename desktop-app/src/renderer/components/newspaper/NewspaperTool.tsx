import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelNewspaperAgentRun,
  cancelNewspaperRun,
  getNewspaperIssue,
  listNewspaperIssues,
  listNewspaperRuns,
  listNewspapers,
  onNewspaperRunEvent,
  startNewspaperRun,
  suggestNewspaperSettings,
  updateNewspaper,
  type Newspaper,
  type NewspaperDeliveryFrequency,
  type NewspaperIssue,
  type NewspaperIssueSummary,
  type NewspaperRun,
  type NewspaperVolume,
  type NewspaperWeatherMode,
} from '../../lib/api';
import { Select, type SelectOption } from '../Select';
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
const DELIVERY_SCHEDULING_ENABLED = false;
const readStyle = (): Exclude<NewspaperVisualStyle, 'editorial'> => {
  const value = localStorage.getItem(STYLE_KEY);
  return value === 'wizarding' || value === 'broadsheet' || value === 'deusEx' || value === 'massEffect'
    ? value
    : 'wizarding';
};

const formatDate = (timestamp: number, locale: string) => new Intl.DateTimeFormat(locale, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
}).format(new Date(timestamp * 1000));

const downloadJson = (filename: string, value: unknown) => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export function NewspaperTool() {
  const { t, i18n } = useTranslation();
  const [newspaper, setNewspaper] = useState<Newspaper | null>(null);
  const [issues, setIssues] = useState<NewspaperIssueSummary[]>([]);
  const [run, setRun] = useState<NewspaperRun | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<NewspaperIssue | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [style, setStyle] = useState<Exclude<NewspaperVisualStyle, 'editorial'>>(readStyle);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interests, setInterests] = useState('');
  const [preferences, setPreferences] = useState('');
  const [sourceRecommendations, setSourceRecommendations] = useState('');
  const [issueVolume, setIssueVolume] = useState<NewspaperVolume>('standard');
  const [weatherMode, setWeatherMode] = useState<NewspaperWeatherMode>('off');
  const [weatherLocation, setWeatherLocation] = useState('');
  const [deliveryFrequency, setDeliveryFrequency] = useState<NewspaperDeliveryFrequency>('manual');
  const [autoFilling, setAutoFilling] = useState(false);
  const [runCollapsed, setRunCollapsed] = useState(false);
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
        setSourceRecommendations(current.source_recommendations);
        setIssueVolume(current.issue_volume);
        setWeatherMode(current.weather_mode);
        setWeatherLocation(current.weather_location);
        setDeliveryFrequency(current.delivery_frequency);
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
        if (alive) setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.load'));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [t]);

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
    if (weatherMode !== 'off' && !weatherLocation.trim()) {
      setError(t('tools.newspapers.errors.weatherLocation'));
      return;
    }
    try {
      const response = await updateNewspaper(newspaper.id, {
        interests,
        preferences,
        source_recommendations: sourceRecommendations,
        issue_volume: issueVolume,
        weather_mode: weatherMode,
        weather_location: weatherLocation,
        delivery_frequency: deliveryFrequency,
        style,
      });
      setNewspaper(response.newspaper);
      setSettingsOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.save'));
    }
  };

  const fillSettingsAutomatically = async () => {
    if (!newspaper || autoFilling) return;
    setError('');
    setAutoFilling(true);
    try {
      const response = await suggestNewspaperSettings(newspaper.id);
      setInterests(response.settings.interests);
      setPreferences(response.settings.preferences);
      setSourceRecommendations(response.settings.source_recommendations);
      if (response.settings.weather_location) {
        setWeatherLocation(response.settings.weather_location);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.autoFill'));
    } finally {
      setAutoFilling(false);
    }
  };

  const createIssue = async () => {
    if (!newspaper || (run && ACTIVE_STATUSES.has(run.status))) return;
    setError('');
    if (weatherMode !== 'off' && !weatherLocation.trim()) {
      setError(t('tools.newspapers.errors.weatherLocation'));
      setSettingsOpen(true);
      return;
    }
    try {
      const saved = await updateNewspaper(newspaper.id, {
        interests,
        preferences,
        source_recommendations: sourceRecommendations,
        issue_volume: issueVolume,
        weather_mode: weatherMode,
        weather_location: weatherLocation,
        delivery_frequency: deliveryFrequency,
        style,
      });
      setNewspaper(saved.newspaper);
      const response = await startNewspaperRun(newspaper.id);
      setRun(response.run);
      setRunCollapsed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.start'));
    }
  };

  const openIssue = async (summary: NewspaperIssueSummary) => {
    setError('');
    try {
      const response = await getNewspaperIssue(summary.id);
      setSelectedIssue(response.issue);
      setPageIndex(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.open'));
    }
  };

  const downloadIssue = async (summary: NewspaperIssueSummary) => {
    setError('');
    try {
      const response = await getNewspaperIssue(summary.id);
      downloadJson(`newspaper-issue-${summary.issue_number}.json`, response.issue);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.export'));
    }
  };

  const stopRun = async () => {
    if (!run) return;
    try {
      const response = await cancelNewspaperRun(run.id);
      setRun(response.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.stop'));
    }
  };

  const stopAgent = async (agentId: number) => {
    if (!run) return;
    try {
      await cancelNewspaperAgentRun(run.id, agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('tools.newspapers.errors.stopResearcher'));
    }
  };

  const active = !!run && ACTIVE_STATUSES.has(run.status);
  const volumeOptions: SelectOption[] = [
    { value: 'compact', label: t('tools.newspapers.volumeOptions.compact.label'), hint: t('tools.newspapers.volumeOptions.compact.hint') },
    { value: 'standard', label: t('tools.newspapers.volumeOptions.standard.label'), hint: t('tools.newspapers.volumeOptions.standard.hint') },
    { value: 'extended', label: t('tools.newspapers.volumeOptions.extended.label'), hint: t('tools.newspapers.volumeOptions.extended.hint') },
  ];
  const weatherOptions = ([
    { value: 'off', label: t('tools.newspapers.weatherOptions.off.label') },
    { value: 'today', label: t('tools.newspapers.weatherOptions.today.label'), hint: t('tools.newspapers.weatherOptions.today.hint') },
    { value: 'week', label: t('tools.newspapers.weatherOptions.week.label'), hint: t('tools.newspapers.weatherOptions.week.hint') },
    { value: 'auto', label: t('tools.newspapers.weatherOptions.auto.label'), hint: t('tools.newspapers.weatherOptions.auto.hint'), badge: { text: t('tools.newspapers.soon'), color: 'info' } },
  ] satisfies SelectOption[]).map(option => option.value === 'auto'
    ? { ...option, disabled: !DELIVERY_SCHEDULING_ENABLED || deliveryFrequency === 'manual' }
    : option);
  const deliveryOptions: SelectOption[] = [
    { value: 'manual', label: t('tools.newspapers.deliveryOptions.manual') },
    { value: 'daily', label: t('tools.newspapers.deliveryOptions.daily') },
    { value: 'every_two_days', label: t('tools.newspapers.deliveryOptions.everyTwoDays') },
    { value: 'weekly', label: t('tools.newspapers.deliveryOptions.weekly') },
  ];
  const currentRunStatus = run
    ? run.status === 'running' && run.phase
      ? run.phase
      : run.error || t(`tools.newspapers.runStatus.${run.status}`)
    : '';

  return <div className={s.root}>
    <div className={s.toolbar}>
      <div><strong>{t('tools.newspapers.title')}</strong><span>{t('tools.newspapers.subtitle')}</span></div>
      <div className={s.toolbarActions}>
        <button type="button" className={s.secondaryButton} onClick={() => setSettingsOpen(value => !value)}>{t('tools.newspapers.configure')}</button>
        <button type="button" onClick={createIssue} disabled={!newspaper || active}>{t('tools.newspapers.create')}</button>
      </div>
    </div>

    <div className={s.scroll}>
      {settingsOpen && <section className={s.settings}>
        <label>{t('tools.newspapers.interests')}<textarea value={interests} onChange={event => setInterests(event.target.value)} placeholder={t('tools.newspapers.interestsPlaceholder')} /></label>
        <label>{t('tools.newspapers.preferences')}<textarea value={preferences} onChange={event => setPreferences(event.target.value)} placeholder={t('tools.newspapers.preferencesPlaceholder')} /></label>
        <label>
          {t('tools.newspapers.recommendedSources')}
          <textarea value={sourceRecommendations} onChange={event => setSourceRecommendations(event.target.value)} placeholder={t('tools.newspapers.sourcesPlaceholder')} />
          <span className={s.settingsHint}>{t('tools.newspapers.sourcesHint')}</span>
        </label>
        <div className={s.settingsGrid}>
          <div className={s.settingField}>
            <span>{t('tools.newspapers.volume')}</span>
            <Select options={volumeOptions} value={issueVolume} onChange={value => setIssueVolume(value as NewspaperVolume)} />
          </div>
          <div className={s.settingField}>
            <span>{t('tools.newspapers.weather')}</span>
            <Select options={weatherOptions} value={weatherMode} onChange={value => setWeatherMode(value as NewspaperWeatherMode)} />
          </div>
        </div>
        {weatherMode !== 'off' && <label>
          {t('tools.newspapers.weatherLocation')}
          <input value={weatherLocation} onChange={event => setWeatherLocation(event.target.value)} placeholder={t('tools.newspapers.weatherLocationPlaceholder')} />
        </label>}
        <div className={s.settingField}>
          <span>{t('tools.newspapers.delivery')}</span>
          <Select
            options={deliveryOptions}
            value={deliveryFrequency}
            onChange={value => setDeliveryFrequency(value as NewspaperDeliveryFrequency)}
            disabled={!DELIVERY_SCHEDULING_ENABLED}
          />
          <span className={s.settingsHint}>{t('tools.newspapers.deliveryHint')}</span>
        </div>
        <div className={s.settingsActions}>
          <button type="button" className={s.secondaryButton} onClick={fillSettingsAutomatically} disabled={autoFilling || !newspaper}>
            {autoFilling ? t('tools.newspapers.autoFilling') : t('tools.newspapers.autoFill')}
          </button>
          <button type="button" className={s.secondaryButton} onClick={() => setSettingsOpen(false)}>{t('common.cancel')}</button>
          <button type="button" onClick={saveSettings}>{t('common.save')}</button>
        </div>
      </section>}

      {error && <div className={s.error}>{error}</div>}

      {run && <section className={`${s.run} ${s[run.status] || ''}`}>
        <header>
          <div><strong>{currentRunStatus}</strong><span>{t('tools.newspapers.runNumber', { number: run.id })}</span></div>
          <div className={s.runActions}>
            {active && <button type="button" className={s.stopButton} onClick={stopRun}>{t('tools.newspapers.stopAll')}</button>}
            <button
              type="button"
              className={s.collapseButton}
              aria-expanded={!runCollapsed}
              onClick={() => setRunCollapsed(value => !value)}
            >
              {runCollapsed ? '+' : '−'}
            </button>
          </div>
        </header>
        {!runCollapsed && run.agents.length > 0 && <div className={s.agents}>
          {run.agents.map(agent => <div className={s.agent} key={agent.id}>
            <div><strong>{agent.agent_type === 'news_researcher' ? t('tools.newspapers.researcher') : agent.agent_type}</strong><span>{agent.task}</span></div>
            <em>{t(`tools.newspapers.agentStatus.${agent.status}`)}</em>
            {agent.status === 'running' && <button type="button" onClick={() => stopAgent(agent.id)}>{t('tools.newspapers.stop')}</button>}
          </div>)}
        </div>}
        {!runCollapsed && (run.draft != null || run.editor_trace != null || run.agents.length > 0) && <details className={s.json}>
          <summary><span>{t('tools.newspapers.editorLog')}</span><button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); downloadJson(`newspaper-run-${run.id}.json`, run); }}>{t('tools.newspapers.downloadRun')}</button></summary>
          <pre>{JSON.stringify({ draft: run.draft, editor_trace: run.editor_trace, agents: run.agents }, null, 2)}</pre>
        </details>}
      </section>}

      {busy ? <div className={s.empty}><span>{t('tools.newspapers.loading')}</span></div> : newspaper && <section className={s.newspaper}>
        <header>
          <div><strong>{newspaper.name}</strong><span>{t(`tools.newspapers.styles.${style}`)}</span></div>
          <span className={s.style}>{t('tools.newspapers.issueCount', { count: issues.length })}</span>
        </header>
        {issues.length > 0 ? <div className={s.issueList}>
          {issues.map(issue => <div className={s.issueRow} key={issue.id}>
            <button type="button" className={s.issue} onClick={() => openIssue(issue)}>
              <div className={s.issueNumber}>{t('tools.newspapers.issueNumber', { number: issue.issue_number })}</div>
              <div className={s.issueInfo}><strong>{issue.title}</strong><span>{formatDate(issue.published_at, i18n.language)} · {t('tools.newspapers.blockCount', { count: issue.blocks_count })}</span></div>
              <span className={s.openArrow}>↗</span>
            </button>
            <button type="button" className={s.downloadIssue} onClick={() => downloadIssue(issue)} title={t('tools.newspapers.downloadIssue')}>↓</button>
          </div>)}
        </div> : <div className={s.empty}><div className={s.emptyIcon}>N</div><strong>{t('tools.newspapers.empty')}</strong><span>{t('tools.newspapers.emptyHint')}</span></div>}
      </section>}
    </div>

    <NewspaperReader
      issue={selectedIssue ? pages[pageIndex] || null : null}
      sourceIssueId={selectedIssue?.id ?? null}
      style={style}
      pageNumber={pageIndex + 1}
      pageCount={pages.length}
      canGoPrevious={pageIndex > 0}
      canGoNext={pageIndex < pages.length - 1}
      onPrevious={() => setPageIndex(index => Math.max(0, index - 1))}
      onNext={() => setPageIndex(index => Math.min(pages.length - 1, index + 1))}
      onClose={() => setSelectedIssue(null)}
      onStyleChange={changeStyle}
      previousLabel={t('tools.newspapers.previousPage')}
      nextLabel={t('tools.newspapers.nextPage')}
      closeLabel={t('common.close')}
    />
  </div>;
}
