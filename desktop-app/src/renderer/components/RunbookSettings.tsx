import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';
import { MarkdownRenderer } from './MarkdownRenderer';

type Runbook = {
  id: number;
  title: string;
  content: string;
  commands: string[];
  created_at: number;
  updated_at: number;
};

export function RunbookSettings() {
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
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

  useEffect(() => { loadRunbooks(); }, []);

  // Command field management (same pattern as MacroSettings)
  const addCommandField = () => setFormCommands(prev => [...prev, '']);
  const removeCommandField = (i: number) => setFormCommands(prev => prev.filter((_, idx) => idx !== i));
  const updateCommandField = (i: number, value: string) => {
    setFormCommands(prev => { const n = [...prev]; n[i] = value; return n; });
  };
  const handleCommandKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && i === formCommands.length - 1 && formCommands[i].trim()) {
      addCommandField();
    }
  };

  const handleExtractCommands = async () => {
    if (!formContent.trim()) {
      toast.error('Введите текст инструкции');
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
        toast.info('Команды не найдены в тексте');
      }
    } catch {
      toast.error('Ошибка извлечения команд');
    } finally {
      setExtracting(false);
    }
  };

  const handleSave = async () => {
    const trimmedTitle = formTitle.trim();
    const trimmedContent = formContent.trim();
    if (!trimmedTitle || !trimmedContent) {
      toast.error('Заполните название и текст');
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
        toast.success('Инструкция обновлена');
      } else {
        await api.apiFetch('/api/v1/devops/runbooks', {
          method: 'POST',
          body: JSON.stringify({ title: trimmedTitle, content: trimmedContent, commands }),
        });
        toast.success('Инструкция создана');
      }
      resetForm();
      loadRunbooks();
    } catch (err: any) {
      toast.error(err?.body?.error || 'Ошибка сохранения');
    } finally {
      setFormSaving(false);
    }
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await api.apiFetch(`/api/v1/devops/runbooks/${id}`, { method: 'DELETE' });
      toast.success('Инструкция удалена');
      if (editingId === id) resetForm();
      loadRunbooks();
    } catch {
      toast.error('Ошибка удаления');
    }
  };

  const handleReview = async (runbook: Runbook) => {
    if (runbook.commands.length === 0) {
      toast.info('В инструкции нет команд для проверки');
      return;
    }
    setReviewingId(runbook.id);
    setReviewResult(null);
    try {
      const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
        method: 'POST',
        body: JSON.stringify({ commands: runbook.commands }),
      });
      setReviewResult(res.verdict);
    } catch {
      toast.error('Не удалось проверить команды');
    } finally {
      setReviewingId(null);
    }
  };

  if (loading) return <div className={s.panel}><div className={s.promptLoading}>Загрузка...</div></div>;

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>Инструкции</div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Название</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formTitle}
          onChange={(e) => setFormTitle(e.target.value)}
          placeholder="Рестарт pm2"
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Текст инструкции (Markdown)</label>
        <textarea
          className={s.textareaInput}
          value={formContent}
          onChange={(e) => setFormContent(e.target.value)}
          placeholder="# Как рестартовать pm2&#10;1. Проверить статус: `pm2 status`&#10;2. Перезапустить: `pm2 restart all`&#10;3. Проверить: `pm2 status`"
          rows={6}
        />
        <button
          className={s.cancelBtn}
          style={{ marginTop: '6px', fontSize: '11px' }}
          onClick={handleExtractCommands}
          disabled={extracting}
        >
          {extracting ? 'Извлекаю...' : '✨ Извлечь команды из текста'}
        </button>
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Команды</label>
        {formCommands.map((cmd, i) => (
          <div key={i} className={s.commandRow}>
            <input
              className={s.fieldInput}
              type="text"
              value={cmd}
              onChange={(e) => updateCommandField(i, e.target.value)}
              onKeyDown={(e) => handleCommandKeyDown(i, e)}
              placeholder={`Команда ${i + 1}`}
              style={{ flex: 1 }}
            />
            {formCommands.length > 1 && (
              <button className={s.macroActionBtn} onClick={() => removeCommandField(i)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        ))}
        <button className={s.cancelBtn} style={{ fontSize: '11px' }} onClick={addCommandField}>
          + Добавить команду
        </button>
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button className={s.saveBtn} onClick={handleSave} disabled={formSaving}>
          {formSaving ? 'Сохранение...' : editingId ? 'Обновить' : 'Создать'}
        </button>
        {editingId !== null && (
          <button className={s.cancelBtn} onClick={resetForm}>Отмена</button>
        )}
      </div>

      {/* Runbook list */}
      {runbooks.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>Сохранённые инструкции</div>
          {runbooks.map((runbook) => (
            <div key={runbook.id} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>{runbook.title}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {runbook.commands.length} команд{runbook.commands.length === 1 ? 'а' : runbook.commands.length > 1 && runbook.commands.length < 5 ? 'ы' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  className={s.macroActionBtn}
                  onClick={() => startEdit(runbook)}
                  title="Редактировать"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  className={s.macroActionBtn}
                  onClick={() => handleReview(runbook)}
                  disabled={reviewingId === runbook.id}
                  title="Спросить ИИ, безопасные ли команды"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </button>
                <button
                  className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                  onClick={() => setDeleteConfirmId(runbook.id)}
                  title="Удалить"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AI review modal */}
      {reviewResult !== null && (
        <div className={s.explainOverlay} onClick={() => setReviewResult(null)}>
          <div className={s.explainBox} onClick={(e) => e.stopPropagation()}>
            <div className={s.explainTitle}>Проверка безопасности ИИ</div>
            <div className={s.explainText}><MarkdownRenderer content={reviewResult} /></div>
            <button className={s.saveBtn} onClick={() => setReviewResult(null)}>
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId !== null && (
        <div className={s.explainOverlay} onClick={() => setDeleteConfirmId(null)}>
          <div className={s.explainBox} onClick={(e) => e.stopPropagation()}>
            <div className={s.explainTitle}>Удалить инструкцию?</div>
            <div className={s.explainText}>Инструкция и все привязанные политики будут удалены.</div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className={s.cancelBtn} onClick={() => setDeleteConfirmId(null)}>Отмена</button>
              <button className={s.saveBtn} style={{ backgroundColor: 'var(--danger, #e53935)' }} onClick={() => handleDelete(deleteConfirmId)}>Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
