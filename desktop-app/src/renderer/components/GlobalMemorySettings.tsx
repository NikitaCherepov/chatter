import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import { Select } from './Select';
import s from './GlobalMemorySettings.module.scss';

type MemorySpace = { id: number; name: string; kind: 'general' | 'chat'; is_default: number; is_primary: number };
type MemoryRecord = { id: string; memory_space_id: number; text: string; source: string; updated_at: number };
type MemoryDialog =
  | { type: 'rename-space'; space: MemorySpace }
  | { type: 'delete-space'; space: MemorySpace }
  | { type: 'edit-record'; record: MemoryRecord }
  | { type: 'delete-record'; record: MemoryRecord };

export function GlobalMemorySettings() {
  const { t } = useTranslation();
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<MemoryDialog | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const generalSpaces = useMemo(() => spaces.filter(space => space.kind === 'general'), [spaces]);
  const selectedSpace = useMemo(
    () => generalSpaces.find(space => String(space.id) === selectedId),
    [generalSpaces, selectedId],
  );

  const loadSpaces = useCallback(async (preferredId?: number) => {
    const result = await api.apiFetch<{ spaces: MemorySpace[] }>('/api/v1/memory/spaces');
    setSpaces(result.spaces);
    const general = result.spaces.filter(space => space.kind === 'general');
    const selected = general.find(space => space.id === preferredId)
      || general.find(space => space.is_default === 1)
      || general[0];
    setSelectedId(selected ? String(selected.id) : '');
  }, []);

  const loadRecords = useCallback(async (spaceId: string) => {
    if (!spaceId) return setRecords([]);
    const result = await api.apiFetch<{ records: MemoryRecord[] }>(`/api/v1/memory/records?space_id=${encodeURIComponent(spaceId)}`);
    setRecords(result.records);
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadSpaces()
      .catch(() => toast.error(t('chat.memory.globalSettings.errors.loadSpaces')))
      .finally(() => setLoading(false));
  }, [loadSpaces, t]);

  useEffect(() => {
    void loadRecords(selectedId).catch(() => toast.error(t('chat.memory.globalSettings.errors.loadRecords')));
  }, [selectedId, loadRecords, t]);

  const selectSpace = async (value: string) => {
    const previous = selectedId;
    setSelectedId(value);
    try {
      await api.apiFetch(`/api/v1/memory/spaces/${encodeURIComponent(value)}/activate`, { method: 'POST' });
      setSpaces(items => items.map(space => ({ ...space, is_default: String(space.id) === value ? 1 : 0 })));
    } catch {
      setSelectedId(previous);
      toast.error(t('chat.memory.globalSettings.errors.selectSpace'));
    }
  };

  const createSpace = async () => {
    const name = newSpaceName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const result = await api.apiFetch<{ space: MemorySpace }>('/api/v1/memory/spaces', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      await api.apiFetch(`/api/v1/memory/spaces/${result.space.id}/activate`, { method: 'POST' });
      await loadSpaces(result.space.id);
      setCreateOpen(false);
      setNewSpaceName('');
    } catch {
      toast.error(t('chat.memory.globalSettings.errors.createSpace'));
    } finally {
      setCreating(false);
    }
  };

  const renameSpace = async () => {
    if (dialog?.type !== 'rename-space' || !draft.trim() || saving) return;
    setSaving(true);
    try {
      await api.apiFetch(`/api/v1/memory/spaces/${dialog.space.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: draft.trim() }),
      });
      await loadSpaces(dialog.space.id);
      setDialog(null);
    } catch {
      toast.error(t('chat.memory.globalSettings.errors.renameSpace'));
    } finally {
      setSaving(false);
    }
  };

  const deleteSpace = async () => {
    if (dialog?.type !== 'delete-space' || saving) return;
    setSaving(true);
    try {
      const result = await api.apiFetch<{ active_space: MemorySpace }>(`/api/v1/memory/spaces/${dialog.space.id}`, {
        method: 'DELETE',
      });
      await loadSpaces(result.active_space.id);
      setDialog(null);
    } catch {
      toast.error(t('chat.memory.globalSettings.errors.deleteSpace'));
    } finally {
      setSaving(false);
    }
  };

  const updateRecord = async () => {
    if (dialog?.type !== 'edit-record' || !draft.trim() || saving) return;
    setSaving(true);
    try {
      const result = await api.apiFetch<{ record: MemoryRecord }>(`/api/v1/memory/records/${encodeURIComponent(dialog.record.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: draft.trim() }),
      });
      setRecords(items => items.map(record => record.id === result.record.id ? result.record : record));
      setDialog(null);
    } catch {
      toast.error(t('chat.memory.globalSettings.errors.updateRecord'));
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = async () => {
    if (dialog?.type !== 'delete-record' || saving) return;
    setSaving(true);
    try {
      await api.apiFetch(`/api/v1/memory/records/${encodeURIComponent(dialog.record.id)}`, { method: 'DELETE' });
      setRecords(items => items.filter(record => record.id !== dialog.record.id));
      setDialog(null);
    } catch {
      toast.error(t('chat.memory.globalSettings.errors.deleteRecord'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.panel}>
      <div className={s.title}>{t('chat.memory.globalSettings.title')}</div>
      <div className={s.hint}>{t('chat.memory.globalSettings.hint')}</div>
      <div className={s.field}>
        <label>{t('chat.memory.globalSettings.spaceLabel')}</label>
        <div className={s.selectorRow}>
          <div className={s.selector}>
            <Select
              options={generalSpaces.map(space => ({ value: String(space.id), label: space.name }))}
              value={selectedId}
              onChange={value => void selectSpace(value)}
              disabled={loading}
            />
          </div>
          <button
            type="button"
            className={s.addButton}
            onClick={() => {
              setNewSpaceName('');
              setCreateOpen(true);
            }}
            title={t('chat.memory.globalSettings.createSpaceAction')}
          >+</button>
          {selectedSpace && (
            <button
              type="button"
              className={s.iconButton}
              onClick={() => {
                setDraft(selectedSpace.name);
                setDialog({ type: 'rename-space', space: selectedSpace });
              }}
              title={t('chat.memory.globalSettings.renameSpaceAction')}
              aria-label={t('chat.memory.globalSettings.renameSpaceAction')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
          )}
          {selectedSpace && selectedSpace.is_primary !== 1 && (
            <button
              type="button"
              className={`${s.iconButton} ${s.dangerButton}`}
              onClick={() => setDialog({ type: 'delete-space', space: selectedSpace })}
              title={t('chat.memory.globalSettings.deleteSpaceAction')}
              aria-label={t('chat.memory.globalSettings.deleteSpaceAction')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
            </button>
          )}
        </div>
      </div>
      <div className={s.sectionTitle}>{t('chat.memory.globalSettings.recordsTitle')}</div>
      <div className={s.records}>
        {!loading && records.length === 0 && <div className={s.empty}>{t('chat.memory.globalSettings.empty')}</div>}
        {records.map(record => (
          <div key={record.id} className={s.record}>
            <div><strong>{record.source}</strong><p>{record.text}</p></div>
            <span className={s.recordActions}>
              <button
                type="button"
                onClick={() => {
                  setDraft(record.text);
                  setDialog({ type: 'edit-record', record });
                }}
                title={t('chat.memory.globalSettings.editRecordAction')}
                aria-label={t('chat.memory.globalSettings.editRecordAction')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button
                type="button"
                className={s.dangerButton}
                onClick={() => setDialog({ type: 'delete-record', record })}
                title={t('chat.memory.globalSettings.deleteRecordAction')}
                aria-label={t('chat.memory.globalSettings.deleteRecordAction')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
              </button>
            </span>
          </div>
        ))}
      </div>
      {createOpen && (
        <ConfirmDialog
          open
          title={t('chat.memory.globalSettings.dialogs.createTitle')}
          text={t('chat.memory.globalSettings.dialogs.createText')}
          confirmLabel={creating ? t('chat.memory.globalSettings.creating') : t('common.create')}
          confirmTone="primary"
          confirmFirst
          confirmDisabled={!newSpaceName.trim() || creating}
          input={{
            value: newSpaceName,
            placeholder: t('chat.memory.globalSettings.dialogs.namePlaceholder'),
            maxLength: 100,
            onChange: setNewSpaceName,
          }}
          onCancel={() => {
            if (!creating) setCreateOpen(false);
          }}
          onConfirm={() => void createSpace()}
        />
      )}
      {dialog?.type === 'rename-space' && (
        <ConfirmDialog
          open
          title={t('chat.memory.globalSettings.dialogs.renameTitle')}
          text={t('chat.memory.globalSettings.dialogs.renameText')}
          confirmLabel={saving ? t('common.saving') : t('common.save')}
          confirmTone="primary"
          confirmFirst
          confirmDisabled={!draft.trim() || saving}
          input={{ value: draft, maxLength: 100, onChange: setDraft }}
          onCancel={() => { if (!saving) setDialog(null); }}
          onConfirm={() => void renameSpace()}
        />
      )}
      {dialog?.type === 'delete-space' && (
        <ConfirmDialog
          open
          title={t('chat.memory.globalSettings.dialogs.deleteSpaceTitle')}
          text={t('chat.memory.globalSettings.dialogs.deleteSpaceText', { name: dialog.space.name })}
          confirmLabel={saving ? t('common.deleting') : t('common.delete')}
          confirmDisabled={saving}
          onCancel={() => { if (!saving) setDialog(null); }}
          onConfirm={() => void deleteSpace()}
        />
      )}
      {dialog?.type === 'edit-record' && (
        <ConfirmDialog
          open
          title={t('chat.memory.globalSettings.dialogs.editRecordTitle')}
          text={t('chat.memory.globalSettings.dialogs.editRecordText')}
          confirmLabel={saving ? t('common.saving') : t('common.save')}
          confirmTone="primary"
          confirmFirst
          confirmDisabled={!draft.trim() || saving}
          input={{ value: draft, maxLength: 4000, multiline: true, onChange: setDraft }}
          onCancel={() => { if (!saving) setDialog(null); }}
          onConfirm={() => void updateRecord()}
        />
      )}
      {dialog?.type === 'delete-record' && (
        <ConfirmDialog
          open
          title={t('chat.memory.globalSettings.dialogs.deleteRecordTitle')}
          text={t('chat.memory.globalSettings.dialogs.deleteRecordText')}
          confirmLabel={saving ? t('common.deleting') : t('common.delete')}
          confirmDisabled={saving}
          onCancel={() => { if (!saving) setDialog(null); }}
          onConfirm={() => void deleteRecord()}
        />
      )}
    </div>
  );
}
