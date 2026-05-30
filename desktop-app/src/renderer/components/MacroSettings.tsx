import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Macro = {
  id: number;
  title: string;
  description: string;
  commands: string[];
  enabled: boolean;
  pinned: boolean;
};

const FS_SCAN_KEY = 'chatter_macro_fs_scan_enabled';

export function loadFsScanEnabled(): boolean {
  return localStorage.getItem(FS_SCAN_KEY) === '1';
}

export function saveFsScanEnabled(enabled: boolean): void {
  localStorage.setItem(FS_SCAN_KEY, enabled ? '1' : '0');
}

// ─── Component ───────────────────────────────────────────────────────────────

type Props = {
  /** Called when macros change, so parent can pick them up */
  onChange?: (macros: Macro[]) => void;
};

export function MacroSettings({ onChange }: Props) {
  const [macros, setMacros] = useState<Macro[]>([]);
  const [loading, setLoading] = useState(true);
  const [fsScanEnabled, setFsScanEnabled] = useState(() => loadFsScanEnabled());

  // Editing state — null = not editing, number = macro id being edited
  const [editingId, setEditingId] = useState<number | null>(null);

  // New macro form state
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCommands, setFormCommands] = useState<string[]>(['']);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formPinned, setFormPinned] = useState(false);

  // AI request states
  const [explaining, setExplaining] = useState<number | null>(null);
  const [explainResult, setExplainResult] = useState<string | null>(null);
  const [describing, setDescribing] = useState<number | null>(null);

  // Execution state
  const [executing, setExecuting] = useState<number | null>(null);

  // ── Load macros from server ──

  const fetchMacros = useCallback(async () => {
    try {
      const res = await api.apiFetch<{ macros: Macro[] }>('/api/v1/macros');
      setMacros(res.macros);
      onChange?.(res.macros);
    } catch (err) {
      console.error('[macros] failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  useEffect(() => { fetchMacros(); }, [fetchMacros]);

  // Persist fs scan toggle
  const updateFsScan = (enabled: boolean) => {
    setFsScanEnabled(enabled);
    saveFsScanEnabled(enabled);
  };

  // ── Form helpers ──

  const resetForm = () => {
    setFormTitle('');
    setFormDescription('');
    setFormCommands(['']);
    setFormEnabled(true);
    setFormPinned(false);
    setEditingId(null);
  };

  const startEdit = (macro: Macro) => {
    setEditingId(macro.id);
    setFormTitle(macro.title);
    setFormDescription(macro.description);
    setFormCommands(macro.commands.length > 0 ? [...macro.commands] : ['']);
    setFormEnabled(macro.enabled);
    setFormPinned(macro.pinned);
  };

  const addCommandField = () => {
    setFormCommands([...formCommands, '']);
  };

  const removeCommandField = (index: number) => {
    setFormCommands(formCommands.filter((_, i) => i !== index));
  };

  const updateCommandField = (index: number, value: string) => {
    const next = [...formCommands];
    next[index] = value;
    setFormCommands(next);
  };

  // ── Save (create / update) ──

  const handleSave = async () => {
    const commands = formCommands.map(c => c.trim()).filter(Boolean);
    if (commands.length === 0) {
      toast.error('Добавьте хотя бы одну команду');
      return;
    }

    const title = formTitle.trim() || `Макрос #${macros.length + 1}`;

    try {
      if (editingId) {
        await api.apiFetch('/api/v1/macros/' + editingId, {
          method: 'PUT',
          body: JSON.stringify({ title, description: formDescription.trim(), commands, enabled: formEnabled, pinned: formPinned }),
        });
        toast.success('Макрос обновлён');
      } else {
        await api.apiFetch('/api/v1/macros', {
          method: 'POST',
          body: JSON.stringify({ title, description: formDescription.trim(), commands, enabled: formEnabled, pinned: formPinned }),
        });
        toast.success('Макрос создан');
      }
      resetForm();
      fetchMacros();
    } catch (err) {
      toast.error('Ошибка сохранения макроса');
      console.error(err);
    }
  };

  // ── Delete ──

  const handleDelete = async (id: number) => {
    try {
      await api.apiFetch('/api/v1/macros/' + id, { method: 'DELETE' });
      if (editingId === id) resetForm();
      fetchMacros();
    } catch (err) {
      toast.error('Ошибка удаления');
      console.error(err);
    }
  };

  // ── Toggle enabled ──

  const handleToggle = async (id: number) => {
    const macro = macros.find(m => m.id === id);
    if (!macro) return;
    try {
      await api.apiFetch('/api/v1/macros/' + id, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !macro.enabled }),
      });
      fetchMacros();
    } catch (err) {
      toast.error('Ошибка');
      console.error(err);
    }
  };

  // ── AI: Explain ──

  const handleExplain = async (macro: Macro) => {
    setExplaining(macro.id);
    setExplainResult(null);
    try {
      const res = await api.apiFetch<{ explanation: string }>('/api/v1/macro/explain', {
        method: 'POST',
        body: JSON.stringify({ commands: macro.commands }),
      });
      setExplainResult(res.explanation);
    } catch (err) {
      toast.error('Не удалось получить объяснение от ИИ');
      console.error(err);
    } finally {
      setExplaining(null);
    }
  };

  // ── AI: Describe ──

  const handleDescribe = async (macro: Macro) => {
    setDescribing(macro.id);
    try {
      const res = await api.apiFetch<{ title: string; description: string }>('/api/v1/macro/describe', {
        method: 'POST',
        body: JSON.stringify({ commands: macro.commands, current_title: macro.title, current_description: macro.description }),
      });
      // Update on server
      await api.apiFetch('/api/v1/macros/' + macro.id, {
        method: 'PUT',
        body: JSON.stringify({ title: res.title || macro.title, description: res.description || macro.description }),
      });
      fetchMacros();
      toast.success('Описание обновлено через ИИ');
    } catch (err) {
      toast.error('Не удалось сгенерировать описание');
      console.error(err);
    } finally {
      setDescribing(null);
    }
  };

  // ── Execute now (via IPC) ──

  const handleExecute = async (macro: Macro) => {
    if (!window.electronAPI?.executeCommands) {
      toast.error('Выполнение команд недоступно');
      return;
    }
    setExecuting(macro.id);
    try {
      const result = await window.electronAPI.executeCommands(macro.commands);
      toast.success('Макрос выполнен');
      console.log('[macro] execution result:', result);
    } catch (err: any) {
      toast.error(`Ошибка: ${err?.message || 'выполнение не удалось'}`);
    } finally {
      setExecuting(null);
    }
  };

  // ── Render ──

  if (loading) {
    return <div className={s.panel}><div className={s.panelTitle}>Макросы</div><div style={{ color: 'var(--text-hint)', fontSize: 13 }}>Загрузка...</div></div>;
  }

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>Макросы</div>

      {/* Macros list */}
      {macros.length === 0 && !editingId && (
        <div style={{ color: 'var(--text-hint)', fontSize: 13, marginBottom: 16 }}>
          Нет макросов. Создайте первый ниже.
        </div>
      )}

      {macros.map((macro) => (
        <div key={macro.id} className={s.macroCard}>
          <div className={s.macroHeader}>
            <label className={s.macroToggleLabel}>
              <input
                type="checkbox"
                checked={macro.enabled}
                onChange={() => handleToggle(macro.id)}
                className={s.macroCheckbox}
              />
              <span className={s.macroTitle}>{macro.title}</span>
            </label>
            <div className={s.macroActions}>
              <button
                className={s.macroActionBtn}
                onClick={() => startEdit(macro)}
                title="Редактировать"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button
                className={s.macroActionBtn}
                onClick={() => handleExecute(macro)}
                disabled={executing === macro.id}
                title="Выполнить сейчас"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </button>
              <button
                className={s.macroActionBtn}
                onClick={() => handleExplain(macro)}
                disabled={explaining === macro.id}
                title="Спросить ИИ, что это делает"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
              <button
                className={s.macroActionBtn}
                onClick={() => handleDescribe(macro)}
                disabled={describing === macro.id}
                title="Улучшить описание ИИ"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
              <button
                className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                onClick={() => handleDelete(macro.id)}
                title="Удалить"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>

          {macro.description && (
            <div className={s.macroDescription}>{macro.description}</div>
          )}

          <div className={s.macroCommands}>
            {macro.commands.map((cmd, i) => (
              <code key={i} className={s.macroCmd}>{cmd}</code>
            ))}
          </div>
        </div>
      ))}

      {/* AI explain modal */}
      {explainResult !== null && (
        <div className={s.explainOverlay} onClick={() => setExplainResult(null)}>
          <div className={s.explainBox} onClick={(e) => e.stopPropagation()}>
            <div className={s.explainTitle}>Объяснение ИИ</div>
            <div className={s.explainText}>{explainResult}</div>
            <button className={s.saveBtn} onClick={() => setExplainResult(null)}>
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Create / Edit form */}
      <div className={s.macroFormDivider} />

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Название</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formTitle}
          onChange={(e) => setFormTitle(e.target.value)}
          placeholder="Название макроса..."
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Описание</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formDescription}
          onChange={(e) => setFormDescription(e.target.value)}
          placeholder="Описание макроса..."
        />
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
              placeholder={`Команда ${i + 1}...`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && i === formCommands.length - 1) {
                  e.preventDefault();
                  addCommandField();
                }
              }}
            />
            {formCommands.length > 1 && (
              <button
                className={s.removeCmdBtn}
                onClick={() => removeCommandField(i)}
                title="Удалить команду"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        ))}
        <button className={s.addCmdBtn} onClick={addCommandField}>
          + Добавить команду
        </button>
      </div>

      <div className={s.fieldGroup}>
        <label className={s.macroToggleLabel}>
          <input
            type="checkbox"
            checked={formEnabled}
            onChange={(e) => setFormEnabled(e.target.checked)}
            className={s.macroCheckbox}
          />
          <span className={s.fieldLabel}>Включён</span>
        </label>
        <label className={s.macroToggleLabel}>
          <input
            type="checkbox"
            checked={formPinned}
            onChange={(e) => setFormPinned(e.target.checked)}
            className={s.macroCheckbox}
          />
          <span className={s.fieldLabel}>Закреплён (AI всегда видит название)</span>
        </label>
      </div>

      <div className={s.macroFormButtons}>
        <button className={s.saveBtn} onClick={handleSave}>
          {editingId ? 'Сохранить изменения' : 'Создать макрос'}
        </button>
        {editingId && (
          <button className={s.cancelBtn} onClick={resetForm}>
            Отмена
          </button>
        )}
      </div>

      {/* FS scan toggle */}
      <div className={s.macroFormDivider} />

      <div className={s.fieldGroup}>
        <label className={s.macroToggleLabel}>
          <input
            type="checkbox"
            checked={fsScanEnabled}
            onChange={(e) => updateFsScan(e.target.checked)}
            className={s.macroCheckbox}
          />
          <span className={s.fieldLabel} style={{ color: 'var(--text-body)' }}>
            Разрешить ИИ сканировать файловую систему (ls/cd)
          </span>
        </label>
      </div>
    </div>
  );
}
