import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { ChatPersonaSelector } from './ChatPersonaSelector';
import s from './MemoryPopover.module.scss';

type MemorySettings = {
  general_space_id: number;
  chat_space_id: number | null;
  memory_mode: 'off' | 'general' | 'chat' | 'both';
  write_target: 'general' | 'chat';
};
type MemoryRecord = { id: string; memory_space_id: number; text: string; source: string; updated_at: number };

export function MemoryPopover({ chatId }: { chatId: number }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const settingsResult = await api.apiFetch<{ settings: MemorySettings }>(`/api/v1/chats/${chatId}/memory-settings`);
      setSettings(settingsResult.settings);
    } catch {
      toast.error(t('chat.memory.loadSettingsFailed'));
    } finally {
      setLoading(false);
    }
  }, [chatId, t]);

  const loadRecords = useCallback(async () => {
    try {
      const result = await api.apiFetch<{ records: MemoryRecord[] }>(`/api/v1/chats/${chatId}/memory-records`);
      setRecords(result.records);
    } catch {
      toast.error(t('chat.memory.loadRecordsFailed'));
    }
  }, [chatId, t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (open) void loadRecords();
  }, [open, settings?.chat_space_id, loadRecords]);

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
      toast.error(t('chat.memory.saveSettingsFailed'));
    }
  };

  const editRecord = async (record: MemoryRecord) => {
    const text = window.prompt(t('chat.memory.promptText'), record.text);
    if (text === null || !text.trim()) return;
    await api.apiFetch(`/api/v1/chats/${chatId}/memory-records/${encodeURIComponent(record.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ text, source: record.source }),
    });
    await loadRecords();
  };

  const deleteRecord = async (record: MemoryRecord) => {
    if (!window.confirm(t('chat.memory.confirmDelete'))) return;
    await api.apiFetch(`/api/v1/chats/${chatId}/memory-records/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    await loadRecords();
  };

  return (
    <div className={s.root} ref={rootRef}>
      <button
        type="button"
        className={`${s.trigger} ${open ? s.triggerActive : ''}`}
        onClick={() => setOpen(value => !value)}
        title={t('chat.memory.triggerTitle')}
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 4A3.5 3.5 0 0 0 6 7.5v.7A3 3 0 0 0 4 11v1a3 3 0 0 0 2 2.8v.7A3.5 3.5 0 0 0 9.5 19H12V4Z" />
          <path d="M14.5 4A3.5 3.5 0 0 1 18 7.5v.7A3 3 0 0 1 20 11v1a3 3 0 0 1-2 2.8v.7a3.5 3.5 0 0 1-3.5 3.5H12" />
        </svg>
        <span>{t('chat.memory.trigger')}</span>
      </button>
      {open && (
        <div className={s.popover}>
          <div className={s.header}><strong>{t('chat.memory.headerTitle')}</strong><span>{loading ? t('common.loading') : t('chat.memory.headerHint')}</span></div>
          {settings && (
            <>
              <label className={s.field}>{t('chat.memory.persona')}
                <ChatPersonaSelector chatId={chatId} embedded />
              </label>
              <label className={s.field}>{t('chat.memory.modeLabel')}
                <select value={settings.memory_mode} onChange={event => void patchSettings({ memory_mode: event.target.value as MemorySettings['memory_mode'] })}>
                  <option value="off">{t('chat.memory.mode.off')}</option>
                  <option value="general">{t('chat.memory.mode.general')}</option>
                  <option value="chat">{t('chat.memory.mode.chat')}</option>
                  <option value="both">{t('chat.memory.mode.both')}</option>
                </select>
              </label>
              {settings.memory_mode === 'both' && (
                <label className={s.field}>{t('chat.memory.writeTargetLabel')}
                  <select value={settings.write_target} onChange={event => void patchSettings({ write_target: event.target.value as MemorySettings['write_target'] })}>
                    <option value="general">{t('chat.memory.writeTarget.general')}</option>
                    <option value="chat">{t('chat.memory.writeTarget.chat')}</option>
                  </select>
                </label>
              )}
              {(settings.memory_mode === 'chat' || settings.memory_mode === 'both') && (
                <>
                  <div className={s.divider} />
                  <div className={s.field}>{t('chat.memory.chatMemoryTitle')}</div>
                  <div className={s.records}>
                    {records.length === 0 && <div className={s.empty}>{t('chat.memory.empty')}</div>}
                    {records.map(record => (
                      <div key={record.id} className={s.record}>
                        <div><strong>{record.source}</strong><p>{record.text}</p></div>
                        <span><button type="button" onClick={() => void editRecord(record)}>✎</button><button type="button" onClick={() => void deleteRecord(record)}>×</button></span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
