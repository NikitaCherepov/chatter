import React, { createContext, useContext, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { extractQuestionnaires, parseQuestionnaireSource, questionnaireSchema, validateQuestionnaireAnswers, type Questionnaire, type QuestionnaireAnswers, type QuestionnaireResponse, type QuestionnaireSubmission } from '../lib/message-questionnaires';
import s from './Questionnaire.module.scss';

export type QuestionnaireContextValue = {
  scope: string;
  messageId: number;
  variantIndex: number;
  content: string;
  disabled: boolean;
  responses: QuestionnaireResponse[];
  onSubmit: (submission: QuestionnaireSubmission) => Promise<void>;
};
export const QuestionnaireContext = createContext<QuestionnaireContextValue | undefined>(undefined);

// Keeping schema in the value avoids sharing a draft after an in-place edit.
export function loadQuestionnaireDraft(key: string, schema: string): QuestionnaireAnswers {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved?.schema === schema && saved.answers && typeof saved.answers === 'object' && !Array.isArray(saved.answers) ? saved.answers : {};
  } catch { return {}; }
}

export function QuestionnaireBlock({ source, closed, fallback }: { source: string; closed: boolean; fallback: React.ReactNode }) {
  const context = useContext(QuestionnaireContext);
  const { t } = useTranslation();
  if (!closed) return <p>{t('questionnaire.waiting')}</p>;
  let form: Questionnaire;
  try { form = parseQuestionnaireSource(source); } catch { return <>{fallback}</>; }
  if (!context || context.messageId <= 0) return <>{fallback}</>;
  const schema = questionnaireSchema(form);
  // Same parser and duplicate-id policy as the server. Never submit an example or half-streamed block.
  if (!extractQuestionnaires(context.content).some(f => questionnaireSchema(f) === schema)) return <>{fallback}</>;
  const key = `chatter:questionnaire:${context.scope}:${context.messageId}:${context.variantIndex}:${form.id}`;
  const submitted = context.responses.find(r => r.source_message_id === context.messageId && r.source_variant_index === context.variantIndex && r.form_id === form.id && r.schema === schema);
  return <QuestionnaireForm key={`${key}:${schema}`} form={form} schema={schema} storageKey={key} context={context} submitted={submitted} />;
}

function QuestionnaireForm({ form, schema, storageKey, context, submitted }: {
  form: Questionnaire; schema: string; storageKey: string; context: QuestionnaireContextValue; submitted?: QuestionnaireResponse;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(() => loadQuestionnaireDraft(storageKey, schema));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unsaved, setUnsaved] = useState(false);
  const values = submitted?.answers ?? answers;
  const update = (questionId: string, value: string | string[]) => {
    const next = { ...answers, [questionId]: value };
    setAnswers(next); setError('');
    try { localStorage.setItem(storageKey, JSON.stringify({ schema, answers: next })); setUnsaved(false); }
    catch { setUnsaved(true); }
  };
  return <form className={s.form} aria-label={form.title} onSubmit={async event => {
    event.preventDefault();
    if (busy || submitted || context.disabled) return;
    let validated: QuestionnaireAnswers;
    try { validated = validateQuestionnaireAnswers(form, answers); }
    catch { setError(t('questionnaire.invalid')); return; }
    setBusy(true); setError('');
    try {
      await context.onSubmit({ source_message_id: context.messageId, source_variant_index: context.variantIndex, form_id: form.id, schema, answers: validated });
      // Only an actual persisted user-message acknowledgement completes submission.
      try { localStorage.removeItem(storageKey); } catch { /* draft cleanup is best effort */ }
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(t(code === 'questionnaire_stale' ? 'questionnaire.stale' : code === 'questionnaire_already_submitted' ? 'questionnaire.alreadySubmitted' : 'questionnaire.sendFailed'));
    } finally { setBusy(false); }
  }}>
    <h3>{form.title}</h3>
    <fieldset disabled={busy || !!submitted || context.disabled}>
      {form.questions.map((q, index) => <fieldset key={q.id} className={s.question}>
        <legend>{index + 1}. {q.label}{q.required ? ' *' : ''}</legend>
        {q.type === 'single' || q.type === 'multiple' ? q.options!.map(option => <label key={option} className={s.option}>
          <input type={q.type === 'single' ? 'radio' : 'checkbox'} name={`${id}-${q.id}`} value={option}
            checked={q.type === 'single' ? values[q.id] === option : Array.isArray(values[q.id]) && (values[q.id] as string[]).includes(option)}
            onChange={e => update(q.id, q.type === 'single' ? option : e.target.checked
              ? [...(Array.isArray(answers[q.id]) ? answers[q.id] as string[] : []), option]
              : (Array.isArray(answers[q.id]) ? answers[q.id] as string[] : []).filter(v => v !== option))} />
          <span>{option}</span>
        </label>) : q.type === 'textarea'
          ? <textarea aria-label={q.label} rows={3} maxLength={4000} required={q.required} value={typeof values[q.id] === 'string' ? values[q.id] as string : ''} onChange={e => update(q.id, e.target.value)} />
          : <input type="text" aria-label={q.label} maxLength={1000} required={q.required} value={typeof values[q.id] === 'string' ? values[q.id] as string : ''} onChange={e => update(q.id, e.target.value)} />}
      </fieldset>)}
      <button type="submit">{t(submitted ? 'questionnaire.submitted' : busy ? 'questionnaire.sending' : 'questionnaire.submit')}</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {unsaved && <p role="status">{t('questionnaire.unsaved')}</p>}
    {!submitted && <small>{t('questionnaire.localDraft')}</small>}
  </form>;
}

export function QuestionnaireResult({ response }: { response: QuestionnaireResponse }) {
  const { t } = useTranslation();
  return <details className={s.result}><summary>{t('questionnaire.result', { title: response.questionnaire.title })}</summary>
    <dl>{response.questionnaire.questions.map(q => <React.Fragment key={q.id}><dt>{q.label}</dt>
      <dd>{Array.isArray(response.answers[q.id]) ? (response.answers[q.id] as string[]).join(', ') || '—' : response.answers[q.id] || '—'}</dd></React.Fragment>)}</dl>
  </details>;
}
