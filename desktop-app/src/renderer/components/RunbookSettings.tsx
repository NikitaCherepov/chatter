import { useTranslation } from 'react-i18next';
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ConfirmDialog } from './ConfirmDialog';

type Runbook = {
  id: number;
  title: string;
  content: string;
  commands: string[];
  created_at: number;
  updated_at: number;
};

type PublicRunbook = {
  id: number;
  title: string;
  content: string;
  commands: string[];
  author_user_id: number;
  author_name: string;
  created_at: number;
  updated_at: number;
};

type Tab = 'personal' | 'public';

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  fontSize: '12px',
  borderRadius: '6px',
  border: 'none',
  cursor: 'pointer',
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? '#fff' : 'var(--text-muted)',
  fontWeight: active ? 600 : 400,
});

// ── Share icon ──────────────────────────────────────────────────────────────
const ShareIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

// ── Save (download) icon ────────────────────────────────────────────────────
const SaveIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

// ── Edit icon ───────────────────────────────────────────────────────────────
const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

// ── Review (?) icon ─────────────────────────────────────────────────────────
const ReviewIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

// ── Delete icon ─────────────────────────────────────────────────────────────
const DeleteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

// ── Remove (×) icon ─────────────────────────────────────────────────────────
const RemoveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export function RunbookSettings({ isAdmin = 0 }: { isAdmin?: number }) {
  const { t } = useTranslation();
  const commandsLabel = (count: number) => t('advanced.runbook.commandCount', { count });
  const [tab, setTab] = useState<Tab>('personal');
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [publicRunbooks, setPublicRunbooks] = useState<PublicRunbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Form
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formCommands, setFormCommands] = useState<string[]>(['']);
  const [formSaving, setFormSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewResult, setReviewResult] = useState<string | null>(null);

  // Public editing (admin)
  const [editingPublicId, setEditingPublicId] = useState<number | null>(null);
  const [editPublicTitle, setEditPublicTitle] = useState('');
  const [editPublicContent, setEditPublicContent] = useState('');
  const [editPublicCommands, setEditPublicCommands] = useState<string[]>(['']);
  const [editPublicSaving, setEditPublicSaving] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setFormTitle('');
    setFormContent('');
    setFormCommands(['']);
  };

  const startEdit = (runbook: Runbook) => {
    setEditingId(runbook.id);
    setFormTitle(runbook.title);
    setFormContent(runbook.content);
    setFormCommands(runbook.commands.length > 0 ? [...runbook.commands] : ['']);
  };

  const startEditPublic = (runbook: PublicRunbook) => {
    setEditingPublicId(runbook.id);
    setEditPublicTitle(runbook.title);
    setEditPublicContent(runbook.content);
    setEditPublicCommands(runbook.commands.length > 0 ? [...runbook.commands] : ['']);
  };

  const loadRunbooks = async () => {
    try {
      const res = await api.apiFetch<{ runbooks: Runbook[] }>('/api/v1/devops/runbooks');
      setRunbooks(res.runbooks);
    } catch (err) {
      console.error('Failed to load runbooks:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadPublicRunbooks = async () => {
    try {
      const res = await api.apiFetch<{ runbooks: PublicRunbook[] }>('/api/v1/devops/runbooks/public');
      setPublicRunbooks(res.runbooks);
    } catch (err) {
      console.error('Failed to load public runbooks:', err);
    }
  };

  useEffect(() => { loadRunbooks(); loadPublicRunbooks(); }, []);

  // Command field management
  const addCommandField = (setter: React.Dispatch<React.SetStateAction<string[]>>) =>
    setter(prev => [...prev, '']);
  const removeCommandField = (i: number, setter: React.Dispatch<React.SetStateAction<string[]>>) =>
    setter(prev => prev.filter((_, idx) => idx !== i));
  const updateCommandField = (i: number, value: string, setter: React.Dispatch<React.SetStateAction<string[]>>) =>
    setter(prev => { const n = [...prev]; n[i] = value; return n; });
  const handleCommandKeyDown = (i: number, e: React.KeyboardEvent, commands: string[], setter: React.Dispatch<React.SetStateAction<string[]>>) => {
    if (e.key === 'Enter' && i === commands.length - 1 && commands[i].trim()) {
      addCommandField(setter);
    }
  };

  const handleExtractCommands = async () => {
    if (!formContent.trim()) {
      toast.error(t('advanced.runbook.enterText'));
      return;
    }
    setExtracting(true);
    try {
      const res = await api.apiFetch<{ commands: string[] }>('/api/v1/devops/runbooks/extract-commands', {
        method: 'POST',
        body: JSON.stringify({ content: formContent }),
      });
      if (res.commands.length > 0) {
        setFormCommands([...res.commands, '']);
        toast.success(`Найдено ${res.commands.length} команд`);
      } else {
        toast.info(t('advanced.runbook.noCommandsFound'));
      }
    } catch {
      toast.error(t('advanced.runbook.extractFailed'));
    } finally {
      setExtracting(false);
    }
  };

  const handleSave = async () => {
    const trimmedTitle = formTitle.trim();
    const trimmedContent = formContent.trim();
    if (!trimmedTitle || !trimmedContent) {
      toast.error(t('advanced.runbook.fillRequired'));
      return;
    }

    const commands = formCommands.filter(c => c.trim());
    setFormSaving(true);
    try {
      if (editingId !== null) {
        await api.apiFetch(`/api/v1/devops/runbooks/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ title: trimmedTitle, content: trimmedContent, commands }),
        });
        toast.success(t('advanced.runbook.updated'));
      } else {
        await api.apiFetch('/api/v1/devops/runbooks', {
          method: 'POST',
          body: JSON.stringify({ title: trimmedTitle, content: trimmedContent, commands }),
        });
        toast.success(t('advanced.runbook.created'));
      }
      resetForm();
      loadRunbooks();
    } catch (err: any) {
      toast.error(err?.body?.error || t('advanced.common.saveFailed'));
    } finally {
      setFormSaving(false);
    }
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deletePublicConfirmId, setDeletePublicConfirmId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await api.apiFetch(`/api/v1/devops/runbooks/${id}`, { method: 'DELETE' });
      toast.success(t('advanced.runbook.deleted'));
      if (editingId === id) resetForm();
      loadRunbooks();
    } catch {
      toast.error(t('advanced.common.deleteFailed'));
    }
  };

  const handlePublish = async (runbook: Runbook) => {
    try {
      await api.apiFetch('/api/v1/devops/runbooks/public', {
        method: 'POST',
        body: JSON.stringify({ title: runbook.title, content: runbook.content, commands: runbook.commands }),
      });
      toast.success(t('advanced.runbook.published'));
      loadPublicRunbooks();
    } catch (err: any) {
      toast.error(err?.body?.error === 'forbidden_admin_only' ? t('advanced.runbook.adminOnly') : t('advanced.runbook.publishFailed'));
    }
  };

  const handleSavePublic = async (publicId: number) => {
    try {
      await api.apiFetch(`/api/v1/devops/runbooks/public/${publicId}/save`, { method: 'POST' });
      toast.success(t('advanced.runbook.savedToMine'));
      loadRunbooks();
    } catch (err: any) {
      toast.error(err?.body?.error === 'runbooks_limit' ? t('advanced.runbook.limitReached') : t('advanced.common.saveFailed'));
    }
  };

  const handleUpdatePublic = async () => {
    if (!editingPublicId) return;
    const trimmedTitle = editPublicTitle.trim();
    const trimmedContent = editPublicContent.trim();
    if (!trimmedTitle || !trimmedContent) {
      toast.error(t('advanced.runbook.fillRequired'));
      return;
    }
    const commands = editPublicCommands.filter(c => c.trim());
    setEditPublicSaving(true);
    try {
      await api.apiFetch(`/api/v1/devops/runbooks/public/${editingPublicId}`, {
        method: 'PUT',
        body: JSON.stringify({ title: trimmedTitle, content: trimmedContent, commands }),
      });
      toast.success(t('advanced.runbook.publicUpdated'));
      setEditingPublicId(null);
      loadPublicRunbooks();
    } catch (err: any) {
      toast.error(err?.body?.error || t('advanced.runbook.updateFailed'));
    } finally {
      setEditPublicSaving(false);
    }
  };

  const handleDeletePublic = async (id: number) => {
    setDeletePublicConfirmId(null);
    try {
      await api.apiFetch(`/api/v1/devops/runbooks/public/${id}`, { method: 'DELETE' });
      toast.success(t('advanced.runbook.publicDeleted'));
      if (editingPublicId === id) setEditingPublicId(null);
      loadPublicRunbooks();
    } catch {
      toast.error(t('advanced.common.deleteFailed'));
    }
  };

  const handleReview = async (commands: string[], id: number) => {
    if (commands.length === 0) {
      toast.info(t('advanced.runbook.noCommandsToReview'));
      return;
    }
    setReviewingId(id);
    setReviewResult(null);
    try {
      const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
        method: 'POST',
        body: JSON.stringify({ commands }),
      });
      setReviewResult(res.verdict);
    } catch {
      toast.error(t('advanced.runbook.reviewFailed'));
    } finally {
      setReviewingId(null);
    }
  };

  if (loading) return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('settings.sections.runbooks')}</div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        <button style={tabStyle(tab === 'personal')} onClick={() => setTab('personal')}>
          {t('advanced.runbook.mine')}
        </button>
        <button style={tabStyle(tab === 'public')} onClick={() => setTab('public')}>
          {t('advanced.runbook.public')}
        </button>
      </div>

      {tab === 'personal' && (<>
        {/* ── Personal: Form ──────────────────────────────────────────────── */}
        <div className={s.fieldGroup}>
          <label className={s.fieldLabel}>{t('advanced.common.name')}</label>
          <input
            className={s.fieldInput}
            type="text"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder={t('advanced.runbook.titlePlaceholder')}
          />
        </div>

        <div className={s.fieldGroup}>
          <label className={s.fieldLabel}>{t('advanced.runbook.markdownText')}</label>
          <textarea
            className={s.textareaInput}
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder={t('advanced.runbook.textPlaceholder')}
            rows={6}
          />
          <button
            className={s.cancelBtn}
            style={{ marginTop: '6px', fontSize: '11px' }}
            onClick={handleExtractCommands}
            disabled={extracting}
          >
            {extracting ? t('advanced.runbook.extracting') : t('advanced.runbook.extract')}
          </button>
        </div>

        <div className={s.fieldGroup}>
          <label className={s.fieldLabel}>{t('advanced.common.commands')}</label>
          {formCommands.map((cmd, i) => (
            <div key={i} className={s.commandRow}>
              <input
                className={s.fieldInput}
                type="text"
                value={cmd}
                onChange={(e) => updateCommandField(i, e.target.value, setFormCommands)}
                onKeyDown={(e) => handleCommandKeyDown(i, e, formCommands, setFormCommands)}
                placeholder={t('advanced.common.commandNumber', { number: i + 1 })}
                style={{ flex: 1 }}
              />
              {formCommands.length > 1 && (
                <button className={s.macroActionBtn} onClick={() => removeCommandField(i, setFormCommands)}>
                  <RemoveIcon />
                </button>
              )}
            </div>
          ))}
          <button className={s.cancelBtn} style={{ fontSize: '11px' }} onClick={() => addCommandField(setFormCommands)}>
            {t('advanced.common.addCommand')}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button className={s.saveBtn} onClick={handleSave} disabled={formSaving}>
            {formSaving ? t('common.saving') : editingId ? t('advanced.common.update') : t('common.create')}
          </button>
          {editingId !== null && (
            <button className={s.cancelBtn} onClick={resetForm}>{t('common.cancel')}</button>
          )}
        </div>

        {/* ── Personal: List ──────────────────────────────────────────────── */}
        {runbooks.length > 0 && (
          <div style={{ marginTop: '16px' }}>
            <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>{t('advanced.runbook.saved')}</div>
            {runbooks.map((runbook) => (
              <div key={runbook.id} className={s.macroCard}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: '13px' }}>{runbook.title}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {commandsLabel(runbook.commands.length)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  {isAdmin === 1 && (
                    <button
                      className={s.macroActionBtn}
                      onClick={() => handlePublish(runbook)}
                      title={t('advanced.runbook.publishForAll')}
                    >
                      <ShareIcon />
                    </button>
                  )}
                  <button
                    className={s.macroActionBtn}
                    onClick={() => startEdit(runbook)}
                    title={t('common.edit')}
                  >
                    <EditIcon />
                  </button>
                  <button
                    className={s.macroActionBtn}
                    onClick={() => handleReview(runbook.commands, runbook.id)}
                    disabled={reviewingId === runbook.id}
                    title={t('advanced.runbook.askSafety')}
                  >
                    <ReviewIcon />
                  </button>
                  <button
                    className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                    onClick={() => setDeleteConfirmId(runbook.id)}
                    title={t('common.delete')}
                  >
                    <DeleteIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </>)}

      {tab === 'public' && (<>
        {/* ── Public: Admin edit form ─────────────────────────────────────── */}
        {editingPublicId !== null && (
          <div style={{ marginBottom: '12px', padding: '10px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
            <div className={s.fieldLabel} style={{ marginBottom: '6px' }}>{t('advanced.runbook.editPublic')}</div>
            <div className={s.fieldGroup}>
              <input
                className={s.fieldInput}
                type="text"
                value={editPublicTitle}
                onChange={(e) => setEditPublicTitle(e.target.value)}
                placeholder={t('advanced.common.name')}
              />
            </div>
            <div className={s.fieldGroup}>
              <textarea
                className={s.textareaInput}
                value={editPublicContent}
                onChange={(e) => setEditPublicContent(e.target.value)}
                placeholder={t('advanced.runbook.text')}
                rows={5}
              />
            </div>
            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('advanced.common.commands')}</label>
              {editPublicCommands.map((cmd, i) => (
                <div key={i} className={s.commandRow}>
                  <input
                    className={s.fieldInput}
                    type="text"
                    value={cmd}
                    onChange={(e) => updateCommandField(i, e.target.value, setEditPublicCommands)}
                    onKeyDown={(e) => handleCommandKeyDown(i, e, editPublicCommands, setEditPublicCommands)}
                    placeholder={t('advanced.common.commandNumber', { number: i + 1 })}
                    style={{ flex: 1 }}
                  />
                  {editPublicCommands.length > 1 && (
                    <button className={s.macroActionBtn} onClick={() => removeCommandField(i, setEditPublicCommands)}>
                      <RemoveIcon />
                    </button>
                  )}
                </div>
              ))}
              <button className={s.cancelBtn} style={{ fontSize: '11px' }} onClick={() => addCommandField(setEditPublicCommands)}>
                {t('advanced.common.addCommand')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className={s.saveBtn} onClick={handleUpdatePublic} disabled={editPublicSaving}>
                {editPublicSaving ? t('common.saving') : t('common.save')}
              </button>
              <button className={s.cancelBtn} onClick={() => setEditingPublicId(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {/* ── Public: List ────────────────────────────────────────────────── */}
        {publicRunbooks.length > 0 ? (
          publicRunbooks.map((runbook) => (
            <div key={runbook.id} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>{runbook.title}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {commandsLabel(runbook.commands.length)} · {runbook.author_name}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  className={s.macroActionBtn}
                  onClick={() => handleSavePublic(runbook.id)}
                  title={t('advanced.runbook.saveToMine')}
                >
                  <SaveIcon />
                </button>
                <button
                  className={s.macroActionBtn}
                  onClick={() => handleReview(runbook.commands, runbook.id)}
                  disabled={reviewingId === runbook.id}
                  title={t('advanced.runbook.askSafety')}
                >
                  <ReviewIcon />
                </button>
                {isAdmin === 1 && (<>
                  <button
                    className={s.macroActionBtn}
                    onClick={() => startEditPublic(runbook)}
                    title={t('common.edit')}
                  >
                    <EditIcon />
                  </button>
                  <button
                    className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                    onClick={() => setDeletePublicConfirmId(runbook.id)}
                    title={t('common.delete')}
                  >
                    <DeleteIcon />
                  </button>
                </>)}
              </div>
            </div>
          ))
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', padding: '20px' }}>
            {t('advanced.runbook.noPublic')}
          </div>
        )}
      </>)}

      {/* AI review modal */}
      {reviewResult !== null && (
        <div className={s.explainOverlay} onClick={() => setReviewResult(null)}>
          <div className={s.explainBox} onClick={(e) => e.stopPropagation()}>
            <div className={s.explainTitle}>{t('advanced.runbook.safetyReview')}</div>
            <div className={s.explainText}><MarkdownRenderer content={reviewResult} /></div>
            <button className={s.saveBtn} onClick={() => setReviewResult(null)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={t('advanced.runbook.deleteTitle')}
        text={t('advanced.runbook.deleteMessage')}
        onCancel={() => setDeleteConfirmId(null)}
        onConfirm={() => handleDelete(deleteConfirmId!)}
      />

      <ConfirmDialog
        open={deletePublicConfirmId !== null}
        title={t('advanced.runbook.deletePublicTitle')}
        text={t('advanced.runbook.deletePublicMessage')}
        onCancel={() => setDeletePublicConfirmId(null)}
        onConfirm={() => handleDeletePublic(deletePublicConfirmId!)}
      />
    </div>
  );
}
