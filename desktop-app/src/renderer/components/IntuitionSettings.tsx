import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useIntuitionSettings } from '../lib/intuition-queries';
import {
  suggestIntuition,
  type IntuitionConfig,
  type IntuitionQuestion,
  type IntuitionSettings as Settings,
} from '../lib/intuition-service';
import Checkbox from './Checkbox';
import { Select } from './Select';
import { AnimatedCollapse, AnimatedDetails } from './AnimatedDisclosure';
import shared from './SettingsModal.module.scss';
import memory from './MemoryPopover.module.scss';
import layout from './SmartHomeSettings.module.scss';
import s from './IntuitionSettings.module.scss';

function Chevron({ open = false }: { open?: boolean }) {
  return (
    <svg
      className={open ? s.chevronOpen : s.chevron}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function IntuitionSettings({ chatId }: { chatId?: number }) {
  const { t } = useTranslation();
  const { query, save } = useIntuitionSettings(chatId);
  const config = query.data;
  const modeLabel = config
    ? t('intuition.' + (config.effective.enabled ? 'enabled' : 'disabled'))
    : t('intuition.loading');
  const content = config ? (
    <IntuitionEditor
      key={String(chatId) + ':' + config.revision}
      data={config}
      chatId={chatId}
      reload={() => void query.refetch()}
      save={async (settings) => {
        await save.mutateAsync({ settings, revision: config.revision });
        toast.success(t('intuition.saved'));
      }}
    />
  ) : (
    <div className={s.loading}>
      {query.isPending ? (
        t('intuition.loading')
      ) : (
        <button type="button" className={shared.cancelBtn} onClick={() => void query.refetch()}>
          {t('intuition.retry')}
        </button>
      )}
    </div>
  );

  if (chatId)
    return (
      <AnimatedDetails
        className={s.chat}
        summary={
          <>
            <Chevron />
            <span className={s.chatTitle}>
              <strong>{t('intuition.title')}</strong>
              <small>
                {config?.settings.mode === 'inherit'
                  ? t('intuition.inheritedStatus', { mode: modeLabel })
                  : modeLabel}
              </small>
            </span>
            <span className={s.configure}>{t('intuition.configure')}</span>
          </>
        }
      >
        <div className={s.embedded}>{content}</div>
      </AnimatedDetails>
    );

  return <div className={s.panel}>{content}</div>;
}

function IntuitionEditor({
  data,
  chatId,
  save,
  reload,
}: {
  data: IntuitionConfig;
  chatId?: number;
  save: (settings: Settings) => Promise<unknown>;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(data.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [suggested, setSuggested] = useState<IntuitionQuestion[] | null>(null);
  const inherited = data.inherited ?? data.effective;
  const questions = draft.questions ?? (chatId ? inherited.questions : data.defaults);
  const changed = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const valid =
    questions.every((q) => q.name.trim() && q.question.trim()) &&
    (draft.historyMessages === null ||
      (Number.isInteger(draft.historyMessages) &&
        draft.historyMessages >= 0 &&
        draft.historyMessages <= 50));
  const change = (id: string, patch: Partial<IntuitionQuestion>) =>
    setDraft({
      ...draft,
      questions: questions.map((question) =>
        question.id === id ? { ...question, ...patch } : question,
      ),
    });
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch {
      setError(t('intuition.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const addQuestion = () => {
    const id = 'signal_' + crypto.randomUUID().replace(/-/g, '');
    setDraft({
      ...draft,
      questions: [...questions, { id, name: '', question: '', enabled: true }],
    });
    setEditingId(id);
  };

  return (
    <div className={s.editor} aria-busy={busy}>
      <div className={s.content} data-intuition-scroll>
        <fieldset className={s.fields} disabled={busy}>
          {!chatId && (
            <header className={s.heading}>
              <h3 className={shared.panelTitle}>{t('intuition.title')}</h3>
              <p className={s.help}>{t('intuition.description')}</p>
            </header>
          )}
          {!data.available && (
            <p className={s.notice} role="note">
              {t('intuition.notConfigured')}
            </p>
          )}
          <div className={s.preferences}>
            {chatId ? (
              <label className={s.field}>
                {t('intuition.mode')}
                <Select
                  floating
                  value={draft.mode}
                  onChange={(value) => setDraft({ ...draft, mode: value as Settings['mode'] })}
                  options={[
                    { value: 'inherit', label: t('intuition.inherit') },
                    { value: 'enabled', label: t('intuition.enabled') },
                    { value: 'disabled', label: t('intuition.disabled') },
                  ]}
                />
              </label>
            ) : (
              <div className={s.enableRow}>
                <div>
                  <strong>{t('intuition.enableTitle')}</strong>
                  <p className={s.help}>{t('intuition.enableHelp')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label={t('intuition.enableTitle')}
                  aria-checked={draft.mode === 'enabled'}
                  className={[
                    memory.toggle,
                    draft.mode === 'enabled' ? memory.toggleActive : '',
                  ].join(' ')}
                  onClick={() =>
                    setDraft({ ...draft, mode: draft.mode === 'enabled' ? 'disabled' : 'enabled' })
                  }
                >
                  <span />
                </button>
              </div>
            )}
            <div className={s.historyRow}>
              <div>
                <label htmlFor={'intuition-depth-' + (chatId ?? 'global')}>
                  {t('intuition.historyShort')}
                </label>
                <p className={s.help}>{t('intuition.historyHelp')}</p>
              </div>
              <input
                className={shared.fieldInput}
                id={'intuition-depth-' + (chatId ?? 'global')}
                type="number"
                min={0}
                max={50}
                value={draft.historyMessages ?? ''}
                placeholder={String(inherited.historyMessages)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    historyMessages: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </div>
          </div>

          <section className={s.signals}>
            <div className={s.sectionHeader}>
              <h4>{t('intuition.signalsTitle')}</h4>
              <button
                type="button"
                className={s.textButton}
                aria-expanded={suggestOpen}
                onClick={() => setSuggestOpen(!suggestOpen)}
              >
                {t('intuition.suggest')}
              </button>
            </div>
            <AnimatedCollapse open={suggestOpen}>
              <div className={s.aiPanel}>
                <label className={s.field}>
                  {t('intuition.brief')}
                  <textarea
                    className={shared.textareaInput}
                    rows={2}
                    maxLength={2000}
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                  />
                </label>
                {chatId && (
                  <Checkbox
                    checked={includeHistory}
                    label={t('intuition.includeHistory')}
                    onChange={setIncludeHistory}
                  />
                )}
                <div className={s.actions}>
                  <button
                    type="button"
                    className={shared.cancelBtn}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setSuggested(
                          (await suggestIntuition(chatId, brief, includeHistory)).questions,
                        );
                      })
                    }
                  >
                    {t('intuition.generate')}
                  </button>
                </div>
                {suggested && (
                  <div className={s.preview}>
                    <p className={s.help}>{t('intuition.draftHelp')}</p>
                    {suggested.map((question) => (
                      <div key={question.id}>
                        <strong>{question.name}</strong>
                        <p>{question.question}</p>
                      </div>
                    ))}
                    <div className={s.actions}>
                      <button
                        type="button"
                        className={shared.cancelBtn}
                        onClick={() => {
                          setDraft({ ...draft, questions: suggested });
                          setSuggested(null);
                          setSuggestOpen(false);
                          setEditingId(null);
                        }}
                      >
                        {t('intuition.useDraft')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </AnimatedCollapse>
            <div className={s.questions}>
              {questions.map((question) => {
                const editing = editingId === question.id;
                return (
                  <div
                    className={[
                      layout.connection,
                      s.question,
                      editing ? s.questionEditing : '',
                    ].join(' ')}
                    key={question.id}
                  >
                    <div className={s.questionRow}>
                      <button
                        type="button"
                        className={s.questionSummary}
                        aria-expanded={editing}
                        onClick={() => setEditingId(editing ? null : question.id)}
                      >
                        <span>
                          <strong>{question.name || t('intuition.newSignal')}</strong>
                          <small>{question.question || t('intuition.questionPlaceholder')}</small>
                        </span>
                        <Chevron open={editing} />
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-label={
                          t('intuition.evaluate') +
                          ' · ' +
                          (question.name || t('intuition.newSignal'))
                        }
                        aria-checked={question.enabled}
                        className={[
                          memory.toggle,
                          question.enabled ? memory.toggleActive : '',
                        ].join(' ')}
                        onClick={() => change(question.id, { enabled: !question.enabled })}
                      >
                        <span />
                      </button>
                    </div>
                    <AnimatedCollapse open={editing}>
                      <div className={s.questionEditor}>
                        <label className={s.field}>
                          {t('intuition.name')}
                          <input
                            className={shared.fieldInput}
                            maxLength={100}
                            autoFocus={!question.name}
                            value={question.name}
                            onChange={(event) => change(question.id, { name: event.target.value })}
                          />
                        </label>
                        <label className={s.field}>
                          {t('intuition.question')}
                          <textarea
                            className={shared.textareaInput}
                            maxLength={1000}
                            rows={3}
                            value={question.question}
                            onChange={(event) =>
                              change(question.id, { question: event.target.value })
                            }
                          />
                        </label>
                        <div className={s.actions}>
                          <button
                            type="button"
                            className={s.deleteButton}
                            onClick={() => {
                              setDraft({
                                ...draft,
                                questions: questions.filter((item) => item.id !== question.id),
                              });
                              setEditingId(null);
                            }}
                          >
                            {t('common.delete')}
                          </button>
                          <button
                            type="button"
                            className={s.textButton}
                            onClick={() => setEditingId(null)}
                          >
                            {t('intuition.collapse')}
                          </button>
                        </div>
                      </div>
                    </AnimatedCollapse>
                  </div>
                );
              })}
            </div>
            <div className={s.listActions}>
              <button
                type="button"
                className={shared.cancelBtn}
                disabled={questions.length >= 20}
                onClick={addQuestion}
              >
                {t('intuition.add')}
              </button>
              <div className={s.actions}>
                <button
                  type="button"
                  className={s.textButton}
                  onClick={() => {
                    setDraft({ ...draft, questions: data.defaults });
                    setEditingId(null);
                  }}
                >
                  {t('intuition.restore')}
                </button>
                {chatId && (
                  <button
                    type="button"
                    className={s.textButton}
                    onClick={() => {
                      setDraft({ ...draft, questions: null, historyMessages: null });
                      setEditingId(null);
                    }}
                  >
                    {t('intuition.useGlobal')}
                  </button>
                )}
              </div>
            </div>
          </section>
        </fieldset>
      </div>
      <footer className={s.footer}>
        <div className={s.footerText}>
          {error ? (
            <>
              <p className={s.error} role="alert">
                {error}
              </p>
              <button type="button" className={s.textButton} disabled={busy} onClick={reload}>
                {t('intuition.reload')}
              </button>
            </>
          ) : (
            <p role="status">{changed ? t('intuition.unsaved') : t('intuition.saveHelp')}</p>
          )}
        </div>
        <button
          type="button"
          className={shared.saveBtn}
          disabled={busy || !valid || !changed}
          onClick={() => void perform(() => save(draft))}
        >
          {busy ? t('intuition.saving') : t('common.save')}
        </button>
      </footer>
    </div>
  );
}
