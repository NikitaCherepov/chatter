'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Textarea } from '../../ui/Textarea/Textarea';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import styles from './PromptsPage.module.css';

type Prompt = {
  id: number;
  name: string;
  description: string;
  content: string;
  is_default: number;
};

type EditState = {
  name: string;
  description: string;
  content: string;
};

export function PromptsPage() {
  const { t } = useTranslation();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<number, EditState>>({});
  const [status, setStatus] = useState<Record<number, string>>({});
  const [newPrompt, setNewPrompt] = useState<EditState>({ name: '', description: '', content: '' });
  const [creating, setCreating] = useState(false);
  const [globalStatus, setGlobalStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api<{ prompts: Prompt[] }>('/api/prompts');
      setPrompts(data.prompts);
      const initial: Record<number, EditState> = {};
      for (const p of data.prompts) {
        initial[p.id] = { name: p.name, description: p.description, content: p.content };
      }
      setEdits(initial);
    } catch {
      setGlobalStatus(`${t('common.error')}: load failed`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const setField = (id: number, field: keyof EditState, value: string) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const showStatus = (id: number, msg: string) => {
    setStatus(prev => ({ ...prev, [id]: msg }));
    setTimeout(() => setStatus(prev => { const n = { ...prev }; delete n[id]; return n; }), 3000);
  };

  const handleUpdate = async (id: number) => {
    const edit = edits[id];
    if (!edit) return;
    try {
      await api(`/api/prompts/${id}/name`, { method: 'PUT', body: JSON.stringify({ name: edit.name }) });
      await api(`/api/prompts/${id}/description`, { method: 'PUT', body: JSON.stringify({ description: edit.description }) });
      await api(`/api/prompts/${id}/content`, { method: 'PUT', body: JSON.stringify({ content: edit.content }) });
      showStatus(id, t('prompts.updateSuccess'));
      await load();
    } catch {
      showStatus(id, `${t('common.error')}`);
    }
  };

  const handleSetDefault = async (id: number) => {
    try {
      await api(`/api/prompts/${id}/default`, { method: 'PUT' });
      showStatus(id, t('prompts.defaultSet'));
      await load();
    } catch {
      showStatus(id, `${t('common.error')}`);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!window.confirm(t('prompts.deleteConfirm', { name }))) return;
    try {
      await api(`/api/prompts/${id}`, { method: 'DELETE' });
      setGlobalStatus(t('prompts.deleteSuccess'));
      setTimeout(() => setGlobalStatus(''), 3000);
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('cannot_delete_default')) {
        setGlobalStatus(t('prompts.cannotDeleteDefault'));
      } else if (msg.includes('cannot_delete_last')) {
        setGlobalStatus(t('prompts.cannotDeleteLast'));
      } else {
        setGlobalStatus(`${t('common.error')}: ${msg}`);
      }
      setTimeout(() => setGlobalStatus(''), 4000);
    }
  };

  const handleCreate = async () => {
    if (!newPrompt.name.trim() || !newPrompt.content.trim()) return;
    setCreating(true);
    try {
      await api('/api/prompts', {
        method: 'POST',
        body: JSON.stringify({
          name: newPrompt.name.trim(),
          description: newPrompt.description.trim(),
          content: newPrompt.content.trim(),
        }),
      });
      setNewPrompt({ name: '', description: '', content: '' });
      setGlobalStatus(t('prompts.createSuccess'));
      setTimeout(() => setGlobalStatus(''), 3000);
      await load();
    } catch {
      setGlobalStatus(`${t('common.error')}`);
      setTimeout(() => setGlobalStatus(''), 3000);
    } finally {
      setCreating(false);
    }
  };

  const isErrorStatus = (msg: string) =>
    msg.startsWith(t('common.error')) ||
    msg === t('prompts.cannotDeleteDefault') ||
    msg === t('prompts.cannotDeleteLast');

  if (loading) return <div className={grid.stack}><p className={styles.hint}>{t('common.saving')}</p></div>;

  return (
    <div className={grid.stack}>
      {globalStatus && (
        <p className={`${styles.statusMessage} ${isErrorStatus(globalStatus) ? styles.statusError : styles.statusSuccess}`}>
          {globalStatus}
        </p>
      )}

      <p className={styles.hint}>{t('prompts.listHint')}</p>

      {prompts.length === 0 && <div className={styles.empty}>{t('prompts.emptyList')}</div>}

      {prompts.map(p => {
        const edit = edits[p.id] || { name: p.name, description: p.description, content: p.content };
        const promptStatus = status[p.id];

        return (
          <details key={p.id} className={styles.section}>
            <summary>
              <span>
                <strong>
                  {p.name}
                  {p.is_default ? <span className={styles.badge}>{t('prompts.defaultBadge')}</span> : null}
                </strong>
                <small>{p.description || '\u00A0'}</small>
              </span>
            </summary>
            <div className={styles.sectionBody}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
                <FormField label={t('prompts.nameLabel')}>
                  <Input
                    value={edit.name}
                    onChange={e => setField(p.id, 'name', e.target.value)}
                    placeholder={t('prompts.namePlaceholder')}
                  />
                </FormField>
                <FormField label={t('prompts.descriptionLabel')}>
                  <Input
                    value={edit.description}
                    onChange={e => setField(p.id, 'description', e.target.value)}
                    placeholder={t('prompts.descriptionPlaceholder')}
                  />
                </FormField>
              </div>

              <FormField label={t('prompts.contentLabel')}>
                <Textarea
                  value={edit.content}
                  onChange={e => setField(p.id, 'content', e.target.value)}
                  placeholder={t('prompts.contentPlaceholder')}
                  rows={8}
                  autoResize
                />
              </FormField>

              {promptStatus && (
                <p className={`${styles.statusMessage} ${isErrorStatus(promptStatus) ? styles.statusError : styles.statusSuccess}`}>
                  {promptStatus}
                </p>
              )}

              <div className={styles.promptActions}>
                <button type="button" onClick={() => handleUpdate(p.id)}>
                  {t('common.saveAndApply')}
                </button>
                {!p.is_default && (
                  <button type="button" onClick={() => handleSetDefault(p.id)}>
                    {t('prompts.setDefault')}
                  </button>
                )}
                {!p.is_default && (
                  <button type="button" className={styles.dangerButton} onClick={() => handleDelete(p.id, p.name)}>
                    {t('prompts.deletePrompt')}
                  </button>
                )}
              </div>
            </div>
          </details>
        );
      })}

      <details className={styles.newSection}>
        <summary>{t('prompts.newPrompt')}</summary>
        <div className={styles.newBody}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
            <FormField label={t('prompts.nameLabel')}>
              <Input
                value={newPrompt.name}
                onChange={e => setNewPrompt(prev => ({ ...prev, name: e.target.value }))}
                placeholder={t('prompts.namePlaceholder')}
              />
            </FormField>
            <FormField label={t('prompts.descriptionLabel')}>
              <Input
                value={newPrompt.description}
                onChange={e => setNewPrompt(prev => ({ ...prev, description: e.target.value }))}
                placeholder={t('prompts.descriptionPlaceholder')}
              />
            </FormField>
          </div>
          <FormField label={t('prompts.contentLabel')}>
            <Textarea
              value={newPrompt.content}
              onChange={e => setNewPrompt(prev => ({ ...prev, content: e.target.value }))}
              placeholder={t('prompts.contentPlaceholder')}
              rows={6}
              autoResize
            />
          </FormField>
          <div className={styles.newActions}>
            <button
              type="button"
              disabled={creating || !newPrompt.name.trim() || !newPrompt.content.trim()}
              onClick={handleCreate}
            >
              {creating ? t('common.saving') : t('prompts.newPrompt')}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
