import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIntuitionSettings } from '../lib/intuition-queries';
import {
  suggestIntuition,
  type IntuitionConfig,
  type IntuitionSettings as Settings,
} from '../lib/intuition-service';
import Checkbox from './Checkbox';
import { Select } from './Select';
import { AnimatedDetails } from './AnimatedDisclosure';
import shared from './SettingsModal.module.scss';
import memory from './MemoryPopover.module.scss';
import s from './IntuitionSettings.module.scss';

export function IntuitionSettings({ chatId }: { chatId?: number }) {
  const { t } = useTranslation();
  const { query, save } = useIntuitionSettings(chatId);
  if (query.isPending) return <p className={s.hint}>{t('intuition.loading')}</p>;
  if (!query.data)
    return (
      <button className={shared.cancelBtn} onClick={() => void query.refetch()}>
        {t('intuition.retry')}
      </button>
    );
  const editor = (
    <IntuitionEditor
      key={String(chatId) + ':' + query.data.revision}
      data={query.data}
      chatId={chatId}
      save={(settings: Settings) => save.mutateAsync({ settings, revision: query.data.revision })}
    />
  );
  return chatId ? (
    <AnimatedDetails className={s.chat} summary={t('intuition.title')}>
      {editor}
    </AnimatedDetails>
  ) : (
    editor
  );
}

function IntuitionEditor({
  data,
  chatId,
  save,
}: {
  data: IntuitionConfig;
  chatId?: number;
  save: (settings: Settings) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(data.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [brief, setBrief] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [suggested, setSuggested] = useState<Settings['questions']>(null);
  const inherited = data.inherited ?? data.effective;
  const questions = draft.questions ?? (chatId ? inherited.questions : data.defaults);
  const change = (index: number, patch: Partial<(typeof questions)[number]>) => {
    setDraft({
      ...draft,
      questions: questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    });
  };
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
  const valid = questions.every((q) => q.name.trim() && q.question.trim());
  return (
    <fieldset className={s.settings} disabled={busy} aria-busy={busy}>
      {!chatId && <h3>{t('intuition.title')}</h3>}
      <p className={s.hint}>{t('intuition.description')}</p>
      {!data.available && <p className={s.notice}>{t('intuition.notConfigured')}</p>}
      <label className={s.field}>
        {t('intuition.mode')}
        <Select
          value={draft.mode}
          onChange={(value) => setDraft({ ...draft, mode: value as Settings['mode'] })}
          options={[
            ...(chatId ? [{ value: 'inherit', label: t('intuition.inherit') }] : []),
            { value: 'enabled', label: t('intuition.enabled') },
            { value: 'disabled', label: t('intuition.disabled') },
          ]}
        />
      </label>
      <label className={s.field}>
        {t('intuition.history')}
        <input
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
      </label>
      <div className={s.actions}>
        <button
          type="button"
          className={shared.cancelBtn}
          disabled={busy}
          onClick={() => setDraft({ ...draft, questions: data.defaults })}
        >
          {t('intuition.restore')}
        </button>
        {chatId && (
          <button
            type="button"
            className={shared.cancelBtn}
            disabled={busy}
            onClick={() => setDraft({ ...draft, questions: null, historyMessages: null })}
          >
            {t('intuition.useGlobal')}
          </button>
        )}
      </div>
      <div className={s.questions}>
        {questions.map((q, index) => (
          <div className={s.question} key={q.id}>
            <div className={s.questionHeader}>
              <input
                aria-label={t('intuition.name')}
                maxLength={100}
                value={q.name}
                onChange={(event) => change(index, { name: event.target.value })}
              />
              <button
                type="button"
                className={shared.cancelBtn}
                onClick={() =>
                  setDraft({ ...draft, questions: questions.filter((_, i) => i !== index) })
                }
              >
                {t('common.delete')}
              </button>
            </div>
            <textarea
              aria-label={t('intuition.question')}
              maxLength={1000}
              rows={2}
              value={q.question}
              onChange={(event) => change(index, { question: event.target.value })}
            />
            <div className={memory.toggleRow}>
              <span>{t('intuition.evaluate')}</span>
              <button
                type="button"
                role="switch"
                aria-label={t('intuition.evaluate')}
                aria-checked={q.enabled}
                className={[memory.toggle, q.enabled ? memory.toggleActive : ''].join(' ')}
                onClick={() => change(index, { enabled: !q.enabled })}
              >
                <span />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={shared.cancelBtn}
        disabled={questions.length >= 20}
        onClick={() =>
          setDraft({
            ...draft,
            questions: [
              ...questions,
              {
                id: 'signal_' + crypto.randomUUID().replace(/-/g, ''),
                name: '',
                question: '',
                enabled: true,
              },
            ],
          })
        }
      >
        {t('intuition.add')}
      </button>
      <AnimatedDetails className={s.suggest} summary={t('intuition.suggest')}>
        <div className={s.settings}>
          <label className={s.field}>
            {t('intuition.brief')}
            <textarea
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
          <button
            type="button"
            className={shared.cancelBtn}
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                setSuggested((await suggestIntuition(chatId, brief, includeHistory)).questions);
              })
            }
          >
            {t('intuition.generate')}
          </button>
          {suggested && (
            <div className={s.draft}>
              <p className={s.hint}>{t('intuition.draftHelp')}</p>
              {suggested.map((q) => (
                <p key={q.id}>
                  <strong>{q.name}</strong>
                  <br />
                  {q.question}
                </p>
              ))}
              <button
                type="button"
                className={shared.cancelBtn}
                onClick={() => {
                  setDraft({ ...draft, questions: suggested });
                  setSuggested(null);
                }}
              >
                {t('intuition.useDraft')}
              </button>
            </div>
          )}
        </div>
      </AnimatedDetails>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className={shared.saveBtn}
        disabled={busy || !valid || JSON.stringify(draft) === JSON.stringify(data.settings)}
        onClick={() => void perform(() => save(draft))}
      >
        {busy ? t('intuition.saving') : t('common.save')}
      </button>
    </fieldset>
  );
}
