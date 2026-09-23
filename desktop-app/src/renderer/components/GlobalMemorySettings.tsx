import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import { Select } from './Select';
import s from './GlobalMemorySettings.module.scss';

type MemorySpace = { id: number; name: string; kind: 'general' | 'chat'; is_default: number };
type MemoryRecord = { id: string; memory_space_id: number; text: string; source: string; updated_at: number };

export function GlobalMemorySettings() {
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [creating, setCreating] = useState(false);

  const generalSpaces = useMemo(() => spaces.filter(space => space.kind === 'general'), [spaces]);

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
      .catch(() => toast.error('Не удалось загрузить общую память'))
      .finally(() => setLoading(false));
  }, [loadSpaces]);

  useEffect(() => {
    void loadRecords(selectedId).catch(() => toast.error('Не удалось загрузить воспоминания'));
  }, [selectedId, loadRecords]);

  const selectSpace = async (value: string) => {
    const previous = selectedId;
    setSelectedId(value);
    try {
      await api.apiFetch(`/api/v1/memory/spaces/${encodeURIComponent(value)}/activate`, { method: 'POST' });
      setSpaces(items => items.map(space => ({ ...space, is_default: String(space.id) === value ? 1 : 0 })));
    } catch {
      setSelectedId(previous);
      toast.error('Не удалось выбрать общую память');
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
      toast.error('Не удалось создать общую память');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={s.panel}>
      <div className={s.title}>Память</div>
      <div className={s.hint}>Общие векторные воспоминания доступны в чатах, где выбран режим «Общая» или «Обе».</div>
      <div className={s.field}>
        <label>Общая память</label>
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
            title="Создать общую память"
          >+</button>
        </div>
      </div>
      <div className={s.sectionTitle}>Воспоминания</div>
      <div className={s.records}>
        {!loading && records.length === 0 && <div className={s.empty}>Здесь пока пусто</div>}
        {records.map(record => (
          <div key={record.id} className={s.record}>
            <div><strong>{record.source}</strong><p>{record.text}</p></div>
          </div>
        ))}
      </div>
      {createOpen && (
        <ConfirmDialog
          open
          title="Новая общая память"
          text="Введите название пространства памяти."
          confirmLabel={creating ? 'Создание…' : 'Создать'}
          confirmTone="primary"
          confirmFirst
          confirmDisabled={!newSpaceName.trim() || creating}
          input={{
            value: newSpaceName,
            placeholder: 'Название памяти',
            maxLength: 100,
            onChange: setNewSpaceName,
          }}
          onCancel={() => {
            if (!creating) setCreateOpen(false);
          }}
          onConfirm={() => void createSpace()}
        />
      )}
    </div>
  );
}
