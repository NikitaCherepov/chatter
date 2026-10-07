import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { useInvalidateMemory } from '../lib/memory-queries';
import { ChatPersonaSelector } from './ChatPersonaSelector';
import { ConfirmDialog } from './ConfirmDialog';
import { MemoryRecordsPanel, type MemoryRecord } from './MemoryRecordsPanel';
import { Select } from './Select';
import { Tooltip } from './Tooltip';
import s from './MemoryPopover.module.scss';

type MemorySettings = {
  general_space_id: number;
  chat_space_id: number | null;
  memory_mode: 'off' | 'general' | 'chat' | 'both';
  write_target: 'general' | 'chat';
  message_search_scope: 'all' | 'current';
  roleplay_mode: number;
  prompt_injection_protection: 'automatic' | 'enabled' | 'disabled';
  automatic_memory: number;
  automatic_memory_mode: 'automatic' | 'enabled' | 'disabled';
  memory_result_limit: number | null;
  effective?: { automaticMemory: boolean; resultLimit: number; inheritedResultLimit: number; inheritedAutomaticMemory: boolean };
};
type RecordDialog = { type: 'edit' | 'delete'; record: MemoryRecord };
type ChatPromptSettings = { prompt_id: number | null; room_enabled: boolean };

export function MemoryPopover({ chatId }: { chatId: number }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>();
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const invalidateMemory = useInvalidateMemory();
  const [dialog, setDialog] = useState<RecordDialog | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [promptSettings, setPromptSettings] = useState<ChatPromptSettings | null>(null);
  const [promptCatalog, setPromptCatalog] = useState<api.PromptsResponse | null>(null);
  const showChatMemory = settings?.memory_mode === 'chat' || settings?.memory_mode === 'both';

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


  useEffect(() => {
    if (open) void load();
  }, [open, load]);


  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.max(0, Math.min(showChatMemory ? 800 : 400, window.innerWidth - 32));
      const top = anchor.bottom + 9;
      setPopoverStyle({
        left: Math.max(16, Math.min(anchor.right - width, window.innerWidth - width - 16)),
        top,
        width,
        maxHeight: Math.max(0, window.innerHeight - top - 16),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, showChatMemory]);

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
      await invalidateMemory();
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
      await invalidateMemory();
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
        <div className={`${s.popover} ${showChatMemory ? '' : s.popoverCompact}`} style={popoverStyle}>
          <div className={s.header}><strong>{t('chat.memory.headerTitle')}</strong><span>{loading ? t('common.loading') : t('chat.memory.headerHint')}</span></div>
          {settings && (
            <div className={s.layout}>
              <div className={s.settingsColumn}>
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
                    </div>
                  </div>
                )}
              </div>
              <label className={s.field}>{t('chat.memory.persona')}
                <ChatPersonaSelector chatId={chatId} embedded />
              </label>
              <div className={s.toggleRow}>
                <div className={s.toggleText}>
                  <strong>{t('chat.memory.roleplayMode.label')}</strong>
                  <span>{t('chat.memory.roleplayMode.hint')}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.roleplay_mode === 1}
                  aria-label={t('chat.memory.roleplayMode.label')}
                  className={`${s.toggle} ${settings.roleplay_mode === 1 ? s.toggleActive : ''}`}
                  disabled={loading}
                  onClick={() => void patchSettings({ roleplay_mode: settings.roleplay_mode === 1 ? 0 : 1 })}
                >
                  <span />
                </button>
              </div>
              <div className={s.field}>{t('chat.memory.injectionProtection.label')}
                <Select
                  value={settings.prompt_injection_protection || 'automatic'}
                  onChange={value => void patchSettings({ prompt_injection_protection: value as MemorySettings['prompt_injection_protection'] })}
                  options={[
                    { value: 'automatic', label: t('chat.memory.injectionProtection.automatic') },
                    { value: 'enabled', label: t('chat.memory.injectionProtection.enabled') },
                    { value: 'disabled', label: t('chat.memory.injectionProtection.disabled') },
                  ]}
                />
                <Tooltip content={t('chat.memory.injectionProtection.help')}>
                  <span className={s.fieldHint} tabIndex={0}>{t('chat.memory.injectionProtection.hint')}</span>
                </Tooltip>
              </div>
              <div className={s.field}>{t('chat.memory.messageSearch.label')}
                <Select
                  value={settings.message_search_scope}
                  onChange={value => void patchSettings({ message_search_scope: value as MemorySettings['message_search_scope'] })}
                  options={[
                    { value: 'all', label: t('chat.memory.messageSearch.all') },
                    { value: 'current', label: t('chat.memory.messageSearch.current') },
                  ]}
                />
              </div>
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
              <div className={s.field}>{t('chat.memory.automaticMemory.label')}
                <Select value={settings.automatic_memory_mode || (settings.automatic_memory === 1 ? 'enabled' : 'automatic')}
                  onChange={value => void patchSettings({ automatic_memory_mode: value as MemorySettings['automatic_memory_mode'] })}
                  options={[
                    { value: 'automatic', label: t('chat.memory.injectionProtection.automatic'), hint: settings.effective ? t(settings.effective.inheritedAutomaticMemory ? 'chat.memory.injectionProtection.enabled' : 'chat.memory.injectionProtection.disabled') : undefined },
                    { value: 'enabled', label: t('chat.memory.injectionProtection.enabled') },
                    { value: 'disabled', label: t('chat.memory.injectionProtection.disabled') },
                  ]} />
                <Tooltip content={t('chat.memory.automaticMemory.help')}>
                  <span tabIndex={0} className={s.fieldHint}>{t(settings.memory_mode === 'off' ? 'chat.memory.automaticMemory.inactive' : 'chat.memory.automaticMemory.hint')}</span>
                </Tooltip>
              </div>
              <div className={s.field}>{t('chat.memory.preferences.limitLabel')}
                <Select value={settings.memory_result_limit == null ? 'automatic' : String(settings.memory_result_limit)}
                  onChange={value => void patchSettings({ memory_result_limit: value === 'automatic' ? null : Number(value) })}
                  options={[
                    { value: 'automatic', label: t('chat.memory.preferences.chatDefault', { count: settings.effective?.inheritedResultLimit ?? '—' }) },
                    ...Array.from({ length: 20 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
                  ]} />
                <Tooltip content={t('chat.memory.preferences.limitHelp')}>
                  <span tabIndex={0} className={s.fieldHint}>{t('chat.memory.preferences.limitHint')}</span>
                </Tooltip>
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
              </div>
              {showChatMemory && (
                <div className={s.memoryColumn}>
                  <div className={s.field}>{t('chat.memory.chatMemoryTitle')}</div>
                  <MemoryRecordsPanel
                    key={chatId}
                    semanticEndpoint={`/api/v1/chats/${chatId}/memory-records/search`}
                    recordsEndpoint={`/api/v1/chats/${chatId}/memory-records`}
                    compact
                    emptyLabel={t('chat.memory.empty')}
                    onEdit={record => {
                      setDraft(record.text);
                      setDialog({ type: 'edit', record });
                    }}
                    onDelete={record => setDialog({ type: 'delete', record })}
                  />
                </div>
              )}
            </div>
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
