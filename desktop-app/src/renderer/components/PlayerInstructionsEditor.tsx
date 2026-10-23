import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import * as prefs from '../lib/player-instructions-api';
import { API_BASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { QuestionnaireAnswers } from '../lib/message-questionnaires';
import { QuestionnaireCard } from './Questionnaire';
import Checkbox from './Checkbox';
import s from './PlayerInstructionsEditor.module.scss';

export function PlayerInstructionsEditor({ scope, targetId, modelId }: { scope: 'persona' | 'chat'; targetId: number; modelId?: string | null }) {
  const { t } = useTranslation();
  const target = { scope, target_id: targetId };
  const [data, setData] = useState<prefs.PlayerInstructions | null>(null);
  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null); setOpen(false); setError('');
    void prefs.getPlayerInstructions(target).then(result => { if (active) { setData(result); setText(result.text); setEnabled(result.enabled); } }, () => { if (active) setError(t('playerInstructions.loadFailed')); });
    return () => { active = false; };
  }, [scope, targetId, t]);
  const applied = (result: { text: string; enabled: boolean }) => {
    setText(result.text); setEnabled(result.enabled); setData(prev => prev ? { ...prev, ...result } : null); setSaved(true);
  };
  return <section className={s.editor}>
    <label className={s.label}>
      <strong>{t(scope === 'persona' ? 'playerInstructions.general' : 'playerInstructions.chat')}</strong>
      <textarea aria-label={t(scope === 'persona' ? 'playerInstructions.general' : 'playerInstructions.chat')} rows={4} maxLength={12000} value={text} disabled={!data || saving}
        placeholder={t('playerInstructions.placeholder')} onChange={e => { setText(e.target.value); setSaved(false); }} />
    </label>
    <small>{t(scope === 'persona' ? 'playerInstructions.generalHelp' : 'playerInstructions.chatHelp')}</small>
    {scope === 'chat' && <Checkbox checked={enabled} disabled={!data || saving} label={t('playerInstructions.enabled')} onChange={value => { setEnabled(value); setSaved(false); }} />}
    <div className={s.actions}>
      <button type="button" disabled={!data || saving} onClick={async () => {
        if (!data) return;
        setSaving(true); setError('');
        try { applied(await prefs.savePlayerInstructions(target, text, enabled, data.text)); }
        catch (e) { setError(t(e instanceof Error && e.message.includes('instructions_changed') ? 'playerInstructions.changed' : 'playerInstructions.saveFailed')); }
        finally { setSaving(false); }
      }}>{t(saving ? 'common.saving' : 'common.save')}</button>
      <button type="button" disabled={!data || saving} onClick={() => setOpen(true)}>{t('playerInstructions.takeSurvey')}</button>
      {saved && <span role="status">{t('playerInstructions.saved')}</span>}
    </div>
    {error && <><p role="alert">{error}</p><button type="button" disabled={saving} onClick={async () => {
      try { const result = await prefs.getPlayerInstructions(target); setData(result); setText(result.text); setEnabled(result.enabled); setError(''); setSaved(false); }
      catch { setError(t('playerInstructions.loadFailed')); }
    }}>{t('playerInstructions.reload')}</button></>}
    {open && data && <PlayerSurveyModal key={`${scope}:${targetId}`} target={target} modelId={modelId} currentText={text} onApplied={applied} onClose={() => {
      setOpen(false);
      void prefs.getPlayerInstructions(target).then(result => {
        setData(prev => prev ? { ...prev, surveys: result.surveys } : result);
        if (result.text !== data.text) setError(t('playerInstructions.changed'));
      }).catch(() => {});
    }} />}
  </section>;
}

function PlayerSurveyModal({ target, modelId, currentText, onApplied, onClose }: {
  target: prefs.InstructionTarget; modelId?: string | null; currentText: string; onApplied: (result: { text: string; enabled: boolean }) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [brief, setBrief] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [includePrompt, setIncludePrompt] = useState(target.scope === 'chat');
  const [personalize, setPersonalize] = useState(false);
  const [surveys, setSurveys] = useState<prefs.PlayerSurvey[]>([]);
  const [selected, setSelected] = useState<prefs.PlayerSurvey | null>(null);
  const [draft, setDraft] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [removeApplied, setRemoveApplied] = useState(false);
  const generationError = (error: unknown) => {
    const code = error instanceof Error ? error.message : '';
    return t(code.includes('quota_exceeded') ? 'playerInstructions.quotaError'
      : code.includes('survey_context_too_large') ? 'playerInstructions.contextError'
      : code.includes('model_not_available') ? 'playerInstructions.modelError'
      : code.includes('survey_busy') ? 'playerInstructions.busyError' : 'playerInstructions.generationFailed');
  };
  const select = (survey: prefs.PlayerSurvey | null) => { setSelected(survey); setDraft(survey?.draft || ''); setReview(false); setError(''); setDeleting(false); setRemoveApplied(false); };
  const refresh = async () => { const result = await prefs.getPlayerInstructions(target); setSurveys(result.surveys); return result; };
  useEffect(() => { let active = true; void prefs.getPlayerInstructions(target).then(result => { if (active) setSurveys(result.surveys); }, () => { if (active) setError(t('playerInstructions.loadFailed')); }); return () => { active = false; }; }, [target.scope, target.target_id, t]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
      if (event.key === 'Tab') {
        const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []).filter(node => node.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyDown, true);
    return () => { document.removeEventListener('keydown', keyDown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const completeAnswers = async (answers: QuestionnaireAnswers) => {
    if (!selected) return;
    setBusy(true); setError('');
    try { const result = await prefs.answerPlayerSurvey(selected.id, answers); select(result.survey); await refresh(); }
    catch (e) {
      setError(generationError(e));
      const restored = await refresh().catch(() => null);
      const savedSurvey = restored?.surveys.find(item => item.id === selected.id);
      if (savedSurvey) { setSelected(savedSurvey); setDraft(savedSurvey.draft || ''); }
      throw e;
    } finally { setBusy(false); }
  };
  return createPortal(<div className={s.overlay} data-native-overlay onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onPointerDown={event => event.stopPropagation()}>
    <div className={s.modal} ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header><h3 id={titleId}>{t(target.scope === 'persona' ? 'playerInstructions.surveyGeneral' : 'playerInstructions.surveyChat')}</h3><button type="button" aria-label={t('common.close')} onClick={onClose}>×</button></header>
      <small>{t('playerInstructions.surveyHelp')}</small>
      {error && <p role="alert">{error}</p>}
      {!selected ? <>
        <label className={s.label}>{t('playerInstructions.brief')}<textarea rows={3} maxLength={2000} value={brief} disabled={busy} onChange={e => setBrief(e.target.value)} placeholder={t('playerInstructions.briefPlaceholder')} /></label>
        <Checkbox checked={includePrompt} disabled={busy} onChange={setIncludePrompt} label={t('playerInstructions.includePrompt')} />
        <small>{t(target.scope === 'chat' ? 'playerInstructions.promptChatHelp' : 'playerInstructions.promptGeneralHelp')}</small>
        {target.scope === 'chat' && <>
          <Checkbox checked={includeHistory} disabled={busy} onChange={setIncludeHistory} label={t('playerInstructions.includeHistory')} />
          <small>{t('playerInstructions.historyHelp')}</small>
        </>}
        <Checkbox checked={personalize} disabled={busy} onChange={setPersonalize} label={t('playerInstructions.personalize')} />
        <small>{t('playerInstructions.personalizeHelp')}</small>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { const result = await prefs.createPlayerSurvey(target, brief, includeHistory, currentText, modelId, personalize, includePrompt); select(result.survey); await refresh(); }
          catch (e) { setError(generationError(e)); }
          finally { setBusy(false); }
        }}>{t(busy ? 'playerInstructions.generating' : 'playerInstructions.generate')}</button>
        {!!surveys.length && <section className={s.history}><h4>{t('playerInstructions.history')}</h4>{surveys.map(survey => <button key={survey.id} type="button" disabled={busy} onClick={() => select(survey)}>{survey.questionnaire.title} · {new Date(survey.created_at * 1000).toLocaleDateString()} {survey.applied_text !== null ? '✓' : ''}</button>)}</section>}
      </> : <>
        <div className={s.actions}><button type="button" disabled={busy} onClick={() => select(null)}>{t('playerInstructions.allSurveys')}</button>
          <button type="button" disabled={busy} onClick={() => setReview(value => !value)}>{t(review ? 'playerInstructions.draft' : 'playerInstructions.review')}</button>
          <button type="button" disabled={busy} onClick={() => setDeleting(value => !value)}>{t('common.delete')}</button></div>
        {deleting && <section className={s.deletePanel}>
          <p>{t('playerInstructions.deleteHelp')}</p>
          {selected.applied_text !== null && <Checkbox checked={removeApplied} onChange={setRemoveApplied} label={t('playerInstructions.restorePrevious')} />}
          <div className={s.actions}><button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { const result = await prefs.deletePlayerSurvey(selected.id, removeApplied); if (removeApplied) onApplied(result); select(null); await refresh(); }
            catch (e) { setError(t(e instanceof Error && e.message.includes('instructions_changed') ? 'playerInstructions.changed' : 'playerInstructions.saveFailed')); }
            finally { setBusy(false); }
          }}>{t('common.delete')}</button><button type="button" disabled={busy} onClick={() => setDeleting(false)}>{t('common.cancel')}</button></div>
        </section>}
        {selected.draft !== null && !review ? <>
          <label className={s.label}>{t('playerInstructions.draft')}<textarea rows={10} maxLength={12000} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} /></label>
          <small>{t('playerInstructions.applyHelp')}</small>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { const result = await prefs.applyPlayerSurvey(selected.id, draft); onApplied(result); setSelected({ ...selected, applied_text: result.text }); await refresh(); }
            catch (e) { setError(t(e instanceof Error && e.message.includes('instructions_changed') ? 'playerInstructions.changed' : 'playerInstructions.saveFailed')); }
            finally { setBusy(false); }
          }}>{t(busy ? 'common.saving' : 'playerInstructions.apply')}</button>
          {selected.applied_text === draft.trim() && <p role="status">{t('playerInstructions.applied')}</p>}
        </> : <>
          <QuestionnaireCard key={selected.id} form={selected.questionnaire} storageKey={`chatter:player-survey:${JSON.stringify([API_BASE, user?.id, selected.id])}`} disabled={busy} submitted={selected.answers || undefined} onSubmit={completeAnswers} />
          {selected.answers && selected.draft === null && <button type="button" disabled={busy} onClick={() => void completeAnswers(selected.answers!).catch(() => {})}>{t(busy ? 'playerInstructions.generating' : 'playerInstructions.retryDraft')}</button>}
        </>}
      </>}
      {busy && <p role="status">{t('playerInstructions.generating')}</p>}
    </div>
  </div>, document.body);
}
