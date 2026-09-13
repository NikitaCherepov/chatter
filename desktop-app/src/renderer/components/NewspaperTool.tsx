import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { NewspaperReader } from './NewspaperReader';
import s from './NewspaperTool.module.scss';

export function NewspaperTool() {
  const { i18n } = useTranslation();
  const ru = i18n.language.toLowerCase().startsWith('ru');
  const tr = useCallback((en: string, russian: string) => ru ? russian : en, [ru]);
  const [newspapers, setNewspapers] = useState<api.Newspaper[]>([]);
  const [issues, setIssues] = useState<Record<number, api.NewspaperIssueSummary[]>>({});
  const [selectedIssue, setSelectedIssue] = useState<api.NewspaperIssue | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<api.NewspaperStyle>('classic');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listNewspapers();
      const nextIssues: Record<number, api.NewspaperIssueSummary[]> = {};
      await Promise.all(result.newspapers.map(async newspaper => {
        const response = await api.listNewspaperIssues(newspaper.id);
        nextIssues[newspaper.id] = response.issues;
      }));
      setNewspapers(result.newspapers);
      setIssues(nextIssues);
    } catch (error: any) {
      toast.error(error?.message || tr('Could not load newspapers', 'Не удалось загрузить газеты'));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => { void load(); }, [load]);

  const openIssue = async (summary: api.NewspaperIssueSummary) => {
    try {
      const result = await api.getNewspaperIssue(summary.id);
      const newspaper = newspapers.find(item => item.id === summary.newspaper_id);
      setSelectedStyle(newspaper?.style || 'classic');
      setSelectedIssue(result.issue);
    } catch (error: any) {
      toast.error(error?.message || tr('Could not open the issue', 'Не удалось открыть выпуск'));
    }
  };

  const createDemo = async () => {
    setCreating(true);
    try {
      const result = await api.createDemoNewspaperIssue();
      await load();
      const newspaper = newspapers.find(item => item.id === result.issue.newspaper_id);
      setSelectedStyle(newspaper?.style || 'classic');
      setSelectedIssue(result.issue);
    } catch (error: any) {
      toast.error(error?.message || tr('Could not create a test issue', 'Не удалось создать тестовый выпуск'));
    } finally {
      setCreating(false);
    }
  };

  const removeIssue = async (event: React.MouseEvent, issue: api.NewspaperIssueSummary) => {
    event.stopPropagation();
    if (!window.confirm(tr('Delete this issue?', 'Удалить этот выпуск?'))) return;
    await api.deleteNewspaperIssue(issue.id);
    if (selectedIssue?.id === issue.id) setSelectedIssue(null);
    await load();
  };

  const currentIssueList = selectedIssue ? (issues[selectedIssue.newspaper_id] || []) : [];
  const currentIndex = selectedIssue ? currentIssueList.findIndex(item => item.id === selectedIssue.id) : -1;
  const goTo = (index: number) => {
    const target = currentIssueList[index];
    if (target) void openIssue(target);
  };

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <div>
          <strong>{tr('Your newspapers', 'Ваши газеты')}</strong>
          <span>{tr('Personal issues collected by Chatter', 'Персональные выпуски от Chatter')}</span>
        </div>
        <button type="button" onClick={() => void createDemo()} disabled={creating}>
          {creating ? tr('Creating…', 'Создаю…') : tr('Test issue', 'Тестовый выпуск')}
        </button>
      </div>

      <div className={s.scroll}>
        {loading && <div className={s.empty}>{tr('Loading…', 'Загрузка…')}</div>}
        {!loading && newspapers.length === 0 && (
          <div className={s.empty}>
            <div className={s.emptyIcon}>Nº</div>
            <strong>{tr('Your first issue is waiting', 'Первый выпуск ещё впереди')}</strong>
            <span>{tr('Create a test newspaper to preview the format.', 'Создайте тестовую газету, чтобы посмотреть формат.')}</span>
          </div>
        )}
        {newspapers.map(newspaper => (
          <section className={s.newspaper} key={newspaper.id}>
            <header>
              <div><strong>{newspaper.name}</strong><span>{newspaper.issue_count} {tr('issues', 'выпусков')}</span></div>
              <span className={s.style}>{newspaper.style}</span>
            </header>
            <div className={s.issueList}>
              {(issues[newspaper.id] || []).map(issue => (
                <div className={s.issueRow} key={issue.id}>
                  <button type="button" className={s.issue} onClick={() => void openIssue(issue)}>
                    <div className={s.issueNumber}>№{issue.issue_number}</div>
                    <div className={s.issueInfo}>
                      <strong>{issue.subtitle || issue.title}</strong>
                      <span>{new Date(issue.published_at * 1000).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long', year: 'numeric' })} · {issue.blocks_count} {tr('sections', 'разделов')}</span>
                    </div>
                    <span className={s.openArrow}>↗</span>
                  </button>
                  <button type="button" className={s.delete} onClick={event => void removeIssue(event, issue)} aria-label={tr('Delete issue', 'Удалить выпуск')}>×</button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <NewspaperReader
        issue={selectedIssue}
        style={selectedStyle}
        canGoPrevious={currentIndex >= 0 && currentIndex < currentIssueList.length - 1}
        canGoNext={currentIndex > 0}
        onPrevious={() => goTo(currentIndex + 1)}
        onNext={() => goTo(currentIndex - 1)}
        onClose={() => setSelectedIssue(null)}
        leadLabel={tr('Lead story', 'Главная история')}
        previousLabel={tr('Previous issue', 'Предыдущий выпуск')}
        nextLabel={tr('Next issue', 'Следующий выпуск')}
        closeLabel={tr('Close', 'Закрыть')}
      />
    </div>
  );
}
