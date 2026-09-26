import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { ChatPersonaSelector } from './ChatPersonaSelector';
import { ConfirmDialog } from './ConfirmDialog';
import { Select } from './Select';
import s from './MemoryPopover.module.scss';

type MemorySettings = {
  general_space_id: number;
  chat_space_id: number | null;
  memory_mode: 'off' | 'general' | 'chat' | 'both';
  write_target: 'general' | 'chat';
};
type MemoryRecord = { id: string; memory_space_id: number; text: string; source: string; updated_at: number };
type RecordDialog = { type: 'edit' | 'delete'; record: MemoryRecord };
type ChatPromptSettings = { prompt_id: number | null; room_enabled: boolean };

export function MemoryPopover({ chatId }: { chatId: number }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [dialog, setDialog] = useState<RecordDialog | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [promptSettings, setPromptSettings] = useState<ChatPromptSettings | null>(null);
  const [promptCatalog, setPromptCatalog] = useState<api.PromptsResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResult, chatPromptResult, promptsResult] = await Promise.all([
        api.apiFetch<{ settings: MemorySettings }>(`/api/v1/chats/${chatId}/memory-settings`),
        api.apiFetch<{ settings: ChatPromptSettings }>(`/api/v1/chats/${chatId}/prompt-settings`),
        api.getPrompts(),
      ]);
      setSettings(settingsResult.settings);
      setPromptSettings(chatPromptResult.settings);
      setPromptCatalog(promptsResult);
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

  const selectChatPrompt = async (value: string) => {
    if (!promptSettings || promptSettings.room_enabled) return;
    const previous = promptSettings;
    const promptId = value === 'automatic' ? null : Number(value);
    setPromptSettings({ ...promptSettings, prompt_id: promptId });
    try {
      const result = await api.apiFetch<{ settings: ChatPromptSettings }>(`/api/v1/chats/${chatId}/prompt-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ prompt_id: promptId }),
      });
      setPromptSettings(result.settings);
    } catch {
      setPromptSettings(previous);
      toast.error(t('chat.memory.characterSelectFailed'));
    }
  };

  const allPrompts = promptCatalog ? [
    ...promptCatalog.prompts.map(prompt => ({ ...prompt, image_url: null as string | null })),
    ...promptCatalog.custom_prompts,
  ] : [];
  const globalPromptId = promptCatalog?.selected_prompt_id
    ?? promptCatalog?.prompts.find(prompt => prompt.is_default === 1)?.id
    ?? null;
  const effectivePromptId = promptSettings?.prompt_id ?? globalPromptId;
  const effectivePrompt = allPrompts.find(prompt => prompt.id === effectivePromptId)
    ?? allPrompts.find(prompt => prompt.id === globalPromptId)
    ?? null;
  const effectivePromptImage = effectivePrompt && 'image_url' in effectivePrompt ? effectivePrompt.image_url : null;
  const promptOptions = [
    {
      value: 'automatic',
      label: t('chat.memory.characterAutomatic'),
      hint: effectivePrompt?.name ? t('chat.memory.characterGlobal', { name: effectivePrompt.name }) : undefined,
    },
    ...allPrompts.map(prompt => ({ value: String(prompt.id), label: prompt.name, hint: prompt.description || undefined })),
  ];

  const updateRecord = async () => {
    if (dialog?.type !== 'edit' || !draft.trim() || saving) return;
    setSaving(true);
    try {
      const result = await api.apiFetch<{ record: MemoryRecord }>(
        `/api/v1/chats/${chatId}/memory-records/${encodeURIComponent(dialog.record.id)}`,
        { method: 'PATCH', body: JSON.stringify({ text: draft.trim() }) },
      );
      setRecords(items => items.map(record => record.id === result.record.id ? result.record : record));
      setDialog(null);
    } catch {
      toast.error(t('advanced.common.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = async () => {
    if (dialog?.type !== 'delete' || saving) return;
    setSaving(true);
    try {
      await api.apiFetch(`/api/v1/chats/${chatId}/memory-records/${encodeURIComponent(dialog.record.id)}`, { method: 'DELETE' });
      setRecords(items => items.filter(record => record.id !== dialog.record.id));
      setDialog(null);
    } catch {
      toast.error(t('advanced.common.deleteFailed'));
    } finally {
      setSaving(false);
    }
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
              <div className={s.field}>{t('chat.memory.character')}
                {promptSettings?.room_enabled ? (
                  <div className={s.roomCharacterHint}>{t('chat.memory.characterRoomManaged')}</div>
                ) : (
                  <div className={s.characterRow}>
                    <div className={s.characterAvatar}>
                      {effectivePromptImage ? (
                        <img src={api.resolveImageUrl(effectivePromptImage, 160)} alt="" />
                      ) : (
                        <span>{effectivePrompt?.name?.slice(0, 1).toUpperCase() || 'C'}</span>
                      )}
                    </div>
                    <div className={s.characterSelect}>
                      <Select
                        value={promptSettings?.prompt_id === null ? 'automatic' : String(promptSettings?.prompt_id ?? 'automatic')}
                        onChange={value => void selectChatPrompt(value)}
                        options={promptOptions}
                        searchable={promptOptions.length > 7}
                        maxVisibleItems={6}
                      />
                      <span>{effectivePrompt?.name || t('chat.memory.characterDefault')}</span>
                    </div>
                  </div>
                )}
              </div>
              <label className={s.field}>{t('chat.memory.persona')}
                <ChatPersonaSelector chatId={chatId} embedded />
              </label>
              <div className={s.field}>{t('chat.memory.modeLabel')}
                <Select
                  value={settings.memory_mode}
                  onChange={value => void patchSettings({ memory_mode: value as MemorySettings['memory_mode'] })}
                  options={[
                    { value: 'off', label: t('chat.memory.mode.off') },
                    { value: 'general', label: t('chat.memory.mode.general') },
                    { value: 'chat', label: t('chat.memory.mode.chat') },
                    { value: 'both', label: t('chat.memory.mode.both') },
                  ]}
                />
              </div>
              {settings.memory_mode === 'both' && (
                <div className={s.field}>{t('chat.memory.writeTargetLabel')}
                  <Select
                    value={settings.write_target}
                    onChange={value => void patchSettings({ write_target: value as MemorySettings['write_target'] })}
                    options={[
                      { value: 'general', label: t('chat.memory.writeTarget.general') },
                      { value: 'chat', label: t('chat.memory.writeTarget.chat') },
                    ]}
                  />
                </div>
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
                        <span className={s.recordActions}>
                          <button
                            type="button"
                            onClick={() => {
                              setDraft(record.text);
                              setDialog({ type: 'edit', record });
                            }}
                            title={t('common.edit')}
                            aria-label={t('common.edit')}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                          </button>
                          <button
                            type="button"
                            className={s.dangerButton}
                            onClick={() => setDialog({ type: 'delete', record })}
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {dialog?.type === 'edit' && (
            <ConfirmDialog
              open
              title={t('common.edit')}
              confirmLabel={saving ? t('common.saving') : t('common.save')}
              confirmTone="primary"
              confirmFirst
              confirmDisabled={!draft.trim() || saving}
              input={{
                value: draft,
                placeholder: t('chat.memory.promptText'),
                maxLength: 4000,
                multiline: true,
                onChange: setDraft,
              }}
              onCancel={() => { if (!saving) setDialog(null); }}
              onConfirm={() => void updateRecord()}
            />
          )}
          {dialog?.type === 'delete' && (
            <ConfirmDialog
              open
              title={t('common.delete')}
              text={t('chat.memory.confirmDelete')}
              confirmLabel={saving ? t('common.deleting') : t('common.delete')}
              confirmDisabled={saving}
              onCancel={() => { if (!saving) setDialog(null); }}
              onConfirm={() => void deleteRecord()}
            />
          )}
        </div>
      )}
    </div>
  );
}
