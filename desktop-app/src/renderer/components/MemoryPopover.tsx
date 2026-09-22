import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { ChatPersonaSelector } from './ChatPersonaSelector';
import s from './MemoryPopover.module.scss';

type MemorySpace = { id: number; name: string; kind: 'general' | 'chat'; chat_id: number | null };
type MemorySettings = {
  general_space_id: number;
  chat_space_id: number | null;
  memory_mode: 'off' | 'general' | 'chat' | 'both';
  write_target: 'general' | 'chat';
  use_core_memory: number;
  allow_core_memory_update: number;
};
type MemoryRecord = { id: string; memory_space_id: number; text: string; source: string; updated_at: number };

export function MemoryPopover({ chatId }: { chatId: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [recordSpaceId, setRecordSpaceId] = useState<number | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [spaceResult, settingsResult] = await Promise.all([
        api.apiFetch<{ spaces: MemorySpace[] }>('/api/v1/memory/spaces'),
        api.apiFetch<{ settings: MemorySettings }>(`/api/v1/chats/${chatId}/memory-settings`),
      ]);
      setSpaces(spaceResult.spaces);
      setSettings(settingsResult.settings);
      setRecordSpaceId(current => current ?? settingsResult.settings.general_space_id);
    } catch {
      toast.error('Не удалось загрузить настройки памяти');
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const loadRecords = useCallback(async (spaceId: number | null) => {
    if (!spaceId) return setRecords([]);
    try {
      const result = await api.apiFetch<{ records: MemoryRecord[] }>(`/api/v1/memory/records?space_id=${spaceId}`);
      setRecords(result.records);
    } catch {
      toast.error('Не удалось загрузить воспоминания');
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (open) void loadRecords(recordSpaceId);
  }, [open, recordSpaceId, loadRecords]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const patchSettings = async (patch: Partial<MemorySettings>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    try {
      const result = await api.apiFetch<{ settings: MemorySettings }>(`/api/v1/chats/${chatId}/memory-settings`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setSettings(result.settings);
      await load();
    } catch {
      setSettings(previous);
      toast.error('Не удалось сохранить настройки памяти');
    }
  };

  const createSpace = async () => {
    const name = window.prompt('Название общей памяти');
    if (!name?.trim()) return;
    await api.apiFetch('/api/v1/memory/spaces', { method: 'POST', body: JSON.stringify({ name }) });
    await load();
  };

  const editRecord = async (record: MemoryRecord) => {
    const text = window.prompt('Текст воспоминания', record.text);
    if (text === null || !text.trim()) return;
    await api.apiFetch(`/api/v1/memory/records/${encodeURIComponent(record.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ text, source: record.source }),
    });
    await loadRecords(recordSpaceId);
  };

  const deleteRecord = async (record: MemoryRecord) => {
    if (!window.confirm('Удалить это воспоминание?')) return;
    await api.apiFetch(`/api/v1/memory/records/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    await loadRecords(recordSpaceId);
  };

  return (
    <div className={s.root} ref={rootRef}>
      <button
        type="button"
        className={`${s.trigger} ${open ? s.triggerActive : ''}`}
        onClick={() => setOpen(value => !value)}
        title="Память этого чата"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 4A3.5 3.5 0 0 0 6 7.5v.7A3 3 0 0 0 4 11v1a3 3 0 0 0 2 2.8v.7A3.5 3.5 0 0 0 9.5 19H12V4Z" />
          <path d="M14.5 4A3.5 3.5 0 0 1 18 7.5v.7A3 3 0 0 1 20 11v1a3 3 0 0 1-2 2.8v.7a3.5 3.5 0 0 1-3.5 3.5H12" />
        </svg>
        <span>Память</span>
      </button>
      {open && (
        <div className={s.popover}>
          <div className={s.header}><strong>Память чата</strong><span>{loading ? 'Загрузка…' : 'Настройки применяются сразу'}</span></div>
          {settings && (
            <>
              <label className={s.field}>Персона
                <ChatPersonaSelector chatId={chatId} embedded />
              </label>
              <label className={s.field}>Использовать память
                <select value={settings.memory_mode} onChange={event => void patchSettings({ memory_mode: event.target.value as MemorySettings['memory_mode'] })}>
                  <option value="off">Не использовать</option>
                  <option value="general">Только общую</option>
                  <option value="chat">Только этого чата</option>
                  <option value="both">Общую и этого чата</option>
                </select>
              </label>
              <label className={s.field}>Общая память
                <span className={s.row}>
                  <select value={settings.general_space_id} onChange={event => void patchSettings({ general_space_id: Number(event.target.value) })}>
                    {spaces.filter(space => space.kind === 'general').map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
                  </select>
                  <button type="button" onClick={() => void createSpace()}>+</button>
                </span>
              </label>
              {(settings.memory_mode === 'chat' || settings.memory_mode === 'both') && (
                <label className={s.field}>Куда сохранять
                  <select value={settings.write_target} onChange={event => void patchSettings({ write_target: event.target.value as MemorySettings['write_target'] })}>
                    <option value="general">В общую память</option>
                    <option value="chat">В память этого чата</option>
                  </select>
                </label>
              )}
              <label className={s.check}><input type="checkbox" checked={Boolean(settings.use_core_memory)} onChange={event => void patchSettings({ use_core_memory: event.target.checked ? 1 : 0 })} />Использовать горячую память</label>
              <label className={s.check}><input type="checkbox" checked={Boolean(settings.allow_core_memory_update)} onChange={event => void patchSettings({ allow_core_memory_update: event.target.checked ? 1 : 0 })} />Разрешить боту обновлять её</label>
              <div className={s.divider} />
              <label className={s.field}>Просмотр воспоминаний
                <select value={recordSpaceId ?? ''} onChange={event => setRecordSpaceId(Number(event.target.value))}>
                  {spaces.map(space => <option key={space.id} value={space.id}>{space.kind === 'chat' ? 'Чат: ' : ''}{space.name}</option>)}
                </select>
              </label>
              <div className={s.records}>
                {records.length === 0 && <div className={s.empty}>Здесь пока пусто</div>}
                {records.map(record => (
                  <div key={record.id} className={s.record}>
                    <div><strong>{record.source}</strong><p>{record.text}</p></div>
                    <span><button type="button" onClick={() => void editRecord(record)}>✎</button><button type="button" onClick={() => void deleteRecord(record)}>×</button></span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
