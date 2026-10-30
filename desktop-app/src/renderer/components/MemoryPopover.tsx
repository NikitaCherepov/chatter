import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { MemorySetupNotice } from './MemorySetupNotice';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { useInvalidateMemory } from '../lib/memory-queries';
import { useQueryClient } from '@tanstack/react-query';
import { useChatPromptKey, type ChatPromptSettings } from '../lib/chat-prompt-queries';
import { ChatPersonaSelector } from './ChatPersonaSelector';
import { PlayerInstructionsEditor } from './PlayerInstructionsEditor';
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

export function MemoryPopover({ chatId, compactTrigger = false, preferredModel }: { chatId: number; compactTrigger?: boolean; preferredModel?: string | null }) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const invalidateMemory = useInvalidateMemory();
  const queryClient = useQueryClient();
  const chatPromptKey = useChatPromptKey(chatId);
  const [dialog, setDialog] = useState<RecordDialog | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const recordDialogState = useRef({ dialog, saving });
  recordDialogState.current = { dialog, saving };
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
      queryClient.setQueryData(chatPromptKey, chatPromptResult);
      setPromptCatalog(promptsResult);
    } catch {
      toast.error(t('chat.memory.loadSettingsFailed'));
    } finally {
      setLoading(false);
    }
  }, [chatId, t, queryClient, chatPromptKey[1], chatPromptKey[2]]);


  useEffect(() => {
    if (open) void load();
  }, [open, load]);


  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modalRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      // Portaled child dialogs own their keyboard handling and focus.
      if (event.defaultPrevented || !modalRef.current?.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (recordDialogState.current.dialog) { if (!recordDialogState.current.saving) setDialog(null); }
        else setOpen(false);
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(node => node.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalRef.current)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => { setOpen(false); setDialog(null); }, [chatId]);

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
      queryClient.setQueryData(chatPromptKey, result);
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
    <div className={s.root}>
      <button
        type="button"
        className={`${s.trigger} ${open ? s.triggerActive : ''}`}
        onClick={() => setOpen(value => !value)}
        title={t('chat.memory.triggerTitle')}
        aria-label={t('chat.memory.trigger')}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 4A3.5 3.5 0 0 0 6 7.5v.7A3 3 0 0 0 4 11v1a3 3 0 0 0 2 2.8v.7A3.5 3.5 0 0 0 9.5 19H12V4Z" />
          <path d="M14.5 4A3.5 3.5 0 0 1 18 7.5v.7A3 3 0 0 1 20 11v1a3 3 0 0 1-2 2.8v.7a3.5 3.5 0 0 1-3.5 3.5H12" />
        </svg>
        {!compactTrigger && <span>{t('chat.memory.trigger')}</span>}
      </button>
      {createPortal(<AnimatePresence>{open && (
        <motion.div key="chat-settings" className={s.overlay} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:.15}} data-native-overlay onMouseDown={event => { if (event.target === event.currentTarget && !dialog) setOpen(false); }}>
        <motion.div className={`${s.popover} ${showChatMemory ? '' : s.popoverCompact}`} initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} exit={{opacity:0,y:16}} transition={{duration:.2,ease:'easeOut'}} ref={modalRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className={s.header}><strong id={titleId}>{t('chat.memory.headerTitle')}</strong><span>{loading ? t('common.loading') : t('chat.memory.headerHint')}</span><button type="button" className={s.close} aria-label={t('common.close')} onClick={() => setOpen(false)}>×</button></div>
          <div className={s.body}>
          <MemorySetupNotice />
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
              <PlayerInstructionsEditor key={chatId} scope="chat" targetId={chatId} modelId={preferredModel} />
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
                    constrainList={false}
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
          </div>
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
        </motion.div>
        </motion.div>
      )}</AnimatePresence>, document.body)}
    </div>
  );
}
