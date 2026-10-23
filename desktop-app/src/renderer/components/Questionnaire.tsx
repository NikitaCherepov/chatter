import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { extractQuestionnaires, formatQuestionnaireAnswer, parseQuestionnaireSource, questionnaireSchema, validateQuestionnaireAnswers, type Questionnaire, type QuestionnaireAnswer, type QuestionnaireAnswers, type QuestionnaireResponse, type QuestionnaireSubmission } from '../lib/message-questionnaires';
import s from './Questionnaire.module.scss';
import Checkbox from './Checkbox';
import { RadioGroup } from './RadioGroup';
import { MessageImage } from './MessageImage';

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
  return <QuestionnaireCard key={`${key}:${schema}`} form={form} storageKey={key} disabled={context.disabled} submitted={submitted?.answers}
    onSubmit={answers => context.onSubmit({ source_message_id: context.messageId, source_variant_index: context.variantIndex, form_id: form.id, schema, answers })} />;
}

export function QuestionnaireCard({ form, storageKey, disabled = false, submitted, onSubmit }: {
  form: Questionnaire; storageKey: string; disabled?: boolean; submitted?: QuestionnaireAnswers; onSubmit: (answers: QuestionnaireAnswers) => Promise<void>;
}) {
  const schema = questionnaireSchema(form);
  const { t } = useTranslation();
  const id = useId();
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(() => loadQuestionnaireDraft(storageKey, schema));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unsaved, setUnsaved] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState(() => {
    if (submitted) return form.questions.length;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return saved?.schema === schema && Number.isInteger(saved.step) ? Math.max(0, Math.min(form.questions.length - 1, saved.step)) : 0;
    } catch { return 0; }
  });
  const legendRef = useRef<HTMLLegendElement>(null);
  const focusAfterTransition = useRef(false);
  const isSubmitted = !!submitted;
  const wasSubmitted = useRef(isSubmitted);
  useEffect(() => {
    if (isSubmitted !== wasSubmitted.current) {
      wasSubmitted.current = isSubmitted;
      focusAfterTransition.current = true;
      setTransitioning(true);
      setStep(isSubmitted ? form.questions.length : form.questions.length - 1);
    }
  }, [isSubmitted, form.questions.length]);
  const completed = isSubmitted && step === form.questions.length;
  const progress = Math.min(step + 1, form.questions.length);
  const values = submitted ?? answers;
  const q = form.questions[Math.min(step, form.questions.length - 1)];
  const currentValue = values[q.id];
  const other = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue) ? currentValue : null;
  const selected = other?.selected ?? (Array.isArray(currentValue) ? currentValue : []);
  const controlsDisabled = busy || transitioning || !!submitted || disabled;
  const persist = (next: QuestionnaireAnswers, nextStep: number) => {
    if (submitted) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ schema, answers: next, step: nextStep })); setUnsaved(false); }
    catch { setUnsaved(true); }
  };
  const update = (questionId: string, value: QuestionnaireAnswer) => {
    const next = { ...answers, [questionId]: value };
    setAnswers(next); setError('');
    persist(next, step);
  };
  const goTo = (nextStep: number) => {
    if (nextStep === step) return;
    focusAfterTransition.current = true;
    setTransitioning(true);
    setStep(nextStep); setError(''); persist(answers, nextStep);
  };
  const validateCurrent = () => {
    if (submitted) return true;
    try { validateQuestionnaireAnswers({ ...form, questions: [q] }, Object.prototype.hasOwnProperty.call(answers, q.id) ? { [q.id]: answers[q.id] } : {}); return true; }
    catch { setError(t('questionnaire.invalid')); return false; }
  };
  return <form className={s.form} aria-label={form.title} aria-busy={busy || transitioning} noValidate onSubmit={async event => {
    event.preventDefault();
    if (busy || transitioning || submitted || disabled) return;
    if (!validateCurrent()) return;
    if (step < form.questions.length - 1) { goTo(step + 1); return; }
    let validated: QuestionnaireAnswers;
    try { validated = validateQuestionnaireAnswers(form, answers); }
    catch {
      const invalidStep = form.questions.findIndex(question => {
        try { validateQuestionnaireAnswers({ ...form, questions: [question] }, Object.prototype.hasOwnProperty.call(answers, question.id) ? { [question.id]: answers[question.id] } : {}); return false; } catch { return true; }
      });
      if (invalidStep >= 0) goTo(invalidStep);
      setError(t('questionnaire.invalid')); return;
    }
    setBusy(true); setError('');
    try {
      await onSubmit(validated);
      // Only an actual persisted user-message acknowledgement completes submission.
      try { localStorage.removeItem(storageKey); } catch { /* draft cleanup is best effort */ }
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setError(t(code === 'questionnaire_stale' ? 'questionnaire.stale' : code === 'questionnaire_already_submitted' ? 'questionnaire.alreadySubmitted' : 'questionnaire.sendFailed'));
    } finally { setBusy(false); }
  }}>
    <div className={s.header}><h3>{form.title}</h3><span className={s.counter} role="status" aria-label={t('questionnaire.progress', { current: progress, total: form.questions.length })}>{progress}/{form.questions.length}</span></div>
    <fieldset className={s.body} disabled={controlsDisabled}>
      <AnimatePresence initial={false} mode="wait">
      <motion.fieldset key={completed ? 'completion' : `question:${q.id}`} className={s.question}
        variants={{ hidden: { opacity: 0, y: reduceMotion ? 0 : 8 }, visible: { opacity: 1, y: 0 }, exit: { opacity: 0, y: reduceMotion ? 0 : -6 } }}
        initial="hidden" animate="visible" exit="exit" transition={{ duration: reduceMotion ? 0 : .14, ease: 'easeOut' }}
        onAnimationComplete={definition => {
          if (definition !== 'visible') return;
          setTransitioning(false);
          if (focusAfterTransition.current) {
            focusAfterTransition.current = false;
            requestAnimationFrame(() => legendRef.current?.focus());
          }
        }}>
        <legend ref={legendRef} tabIndex={-1}>{completed ? t('questionnaire.completedTitle') : `${step + 1}. ${q.label}${q.required ? ' *' : ''}`}</legend>
        {completed ? <div className={s.completion} role="status">
          <svg aria-hidden="true" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path d="m7 12 3 3 7-7" /></svg>
          <p>{t('questionnaire.completedDescription')}</p>
        </div> : <>
        <div className={s.questionContent}>
        {q.image && <div className={s.questionImage}><MessageImage src={q.image.url} alt={q.image.alt} /></div>}
        <div className={s.questionFields}>
        {q.type === 'single' || q.type === 'multiple' ? <>
          {q.type === 'single' ? <RadioGroup key={q.id} layout="inline" className={s.choices} name={`${id}-${q.id}`} disabled={controlsDisabled}
            options={[...q.options!.map((option, index) => ({ value: `option:${index}`, label: option })), ...(q.allowOther ? [{ value: 'other', label: t('questionnaire.other') }] : [])]}
            value={other ? 'other' : typeof currentValue === 'string' && q.options!.includes(currentValue) ? `option:${q.options!.indexOf(currentValue)}` : ''}
            onChange={value => update(q.id, value === 'other' ? { other: '' } : q.options![Number(value.slice(7))])} />
            : <div className={s.choices}>{q.options!.map(option => <Checkbox key={option} className={s.option} label={option}
              checked={selected.includes(option)} disabled={controlsDisabled} onChange={checked => {
                const next = checked ? [...selected, option] : selected.filter(v => v !== option);
                update(q.id, other ? { other: other.other, selected: next } : next);
              }} />)}
              {q.allowOther && <Checkbox className={s.option} label={t('questionnaire.other')} checked={!!other} disabled={controlsDisabled}
                onChange={checked => update(q.id, checked ? { other: '', selected } : selected)} />}
            </div>}
          {q.allowOther && other && <input className={s.otherText} type="text" aria-label={t('questionnaire.otherText')} placeholder={t('questionnaire.otherText')} maxLength={1000}
              value={other.other} onChange={e => update(q.id, q.type === 'single' ? { other: e.target.value } : { other: e.target.value, selected })} />}
        </> : q.type === 'textarea'
          ? <textarea aria-label={q.label} rows={3} maxLength={4000} required={q.required} value={typeof values[q.id] === 'string' ? values[q.id] as string : ''} onChange={e => update(q.id, e.target.value)} />
          : <input type="text" aria-label={q.label} maxLength={1000} required={q.required} value={typeof values[q.id] === 'string' ? values[q.id] as string : ''} onChange={e => update(q.id, e.target.value)} />}
        </div>
        </div>
        </>}
      </motion.fieldset>
      </AnimatePresence>
    </fieldset>
    <div className={s.navigation}>
      <button type="button" disabled={step === 0 || busy || transitioning || disabled} onClick={() => goTo(step - 1)}>{t('questionnaire.back')}</button>
      {step < form.questions.length - 1 + (isSubmitted ? 1 : 0)
        ? <button key="next" type="button" disabled={busy || transitioning || disabled} onClick={event => { event.preventDefault(); if (validateCurrent()) goTo(step + 1); }}>{t('questionnaire.next')}</button>
        : <button key="submit" type="submit" disabled={busy || transitioning || !!submitted || disabled}>{t(submitted ? 'questionnaire.submitted' : busy ? 'questionnaire.sending' : 'questionnaire.submit')}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {unsaved && <p role="status">{t('questionnaire.unsaved')}</p>}
    {!submitted && <small>{t('questionnaire.localDraft')}</small>}
  </form>;
}

export function QuestionnaireResult({ response, onImageClick }: { response: QuestionnaireResponse; onImageClick?: (src: string) => void }) {
  const { t } = useTranslation();
  return <details className={s.result}><summary>{t('questionnaire.result', { title: response.questionnaire.title })}</summary>
    <dl>{response.questionnaire.questions.map(q => <React.Fragment key={q.id}><dt>{q.label}</dt>
      <dd>{q.image && <div className={s.questionImage}><MessageImage src={q.image.url} alt={q.image.alt} onImageClick={onImageClick} /></div>}{formatQuestionnaireAnswer(response.answers[q.id])}</dd></React.Fragment>)}</dl>
  </details>;
}
