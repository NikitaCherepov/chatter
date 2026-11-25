import type { QueryClient } from '@tanstack/react-query';
import type { SettingValue } from '../../main/settings-shell-types';
import type { ThemeSettingsSectionAdapter } from './theme-settings-controller';
import type { SettingsTranslate } from './settings-fields';
import { settingsFields } from './settings-fields';
import { SECTION_SETTING_KEYS as keys } from './settings-field-keys';
import * as api from './api';
import { settingsReads } from './settings-service';
import { getLanguageDisplayName, SUPPORTED_LANGUAGES } from '../i18n';
import { fetchPiperVoiceList, fetchRemoteTtsProviders, getTtsModels, getTtsSettings, setTtsSettings, ttsPreview, ttsStopPreview, type TtsModel } from './tts';
import { getSpeechRecognitionLanguage, getSpeechRecognitionSource, setSpeechRecognitionLanguage, setSpeechRecognitionSource, type SpeechRecognitionLanguage } from './speechRecognition';
import { WAKE_WORD_CHOICES } from '../../main/wakeword-config';
import { getWakeWordEnabled, getWakeWordConfig, setWakeWordEnabled, setWakeWordConfig } from './wakeWordToggle';
import { saveAppUiSettings } from './app-settings';

type UserPatch = Partial<Pick<api.AuthResponse['user'], 'name' | 'timezone_offset' | 'timezone_confirmed' | 'subagent_model' | 'subagent_reasoning_level' | 'ui_settings'>>;
type Context = { client: QueryClient; base: string; userId: number | undefined; current: () => boolean; t: SettingsTranslate; patchUser: (patch: UserPatch) => void };

/** Adapters use the existing services and query keys, never theme-specific preference storage. */
export function createThemeSettingsSections(context: Context): Record<string, ThemeSettingsSectionAdapter> {
  const { client, base, userId, current, t, patchUser } = context;
  const guard = () => { if (!current() || userId == null) throw new Error('settings_scope_changed'); };
  const read = <T,>(key: keyof typeof settingsReads) => {
    guard();
    return client.fetchQuery({ queryKey: ['settings', base, userId, key], queryFn: () => { guard(); return (settingsReads[key] as () => Promise<T>)(); }, staleTime: 0 });
  };
  const cache = (key: string, value: unknown) => { if (current()) client.setQueryData(['settings', base, userId, key], value); };
  const group = (id: string, key: string) => ({ id, label: t(key) });
  let voices: TtsModel[] = [], serverRecognition = false;
  let contextCap = 0;
  let memoryDefault = 0;
  let agentModels: api.ModelCatalogEntry[] = [], autoReasoning: api.ReasoningLevel[] = [];
  const voiceOptions = (model: SettingValue) => voices.find(item => item.id === model)?.voices.map(voice => ({ value: voice.id, label: `${voice.name} (${voice.lang})` })) ?? [];
  const agentReasoning = (model: SettingValue) => model ? agentModels.find(item => item.id === model)?.reasoning_levels ?? [] : autoReasoning;
  const keepUnavailable = (options: { value: string; label: string; disabled?: boolean }[], saved: SettingValue) =>
    typeof saved === 'string' && !options.some(option => option.value === saved) ? [...options, { value: saved, label: saved || '—', disabled: true }] : options;
  return {
    ...Object.fromEntries(['prompt','personas'].map(section=>[section,{
      groups:()=>[],fields:()=>[],read:async()=>({}),
      links:()=>[{id:'import',sectionId:'data',target:'settings.sections.data',label:t('settings.sections.data')}],
      write:async()=>{throw new Error('invalid_setting_field');},
    }])),
    intuition: {
      groups:()=>[],links:()=>[],fields:()=>[],read:async()=>({}),
      write:async()=>{throw new Error('invalid_setting_field');},
    },
    memory: {
      groups: () => [group('preferences', 'chat.memory.globalSettings.preferencesTitle')],
      links: () => [],
      read: async () => { const { preferences } = await read<Awaited<ReturnType<typeof api.getMemoryPreferences>>>('memoryPreferences');
        guard(); memoryDefault = preferences.admin_result_limit;
        return { automaticMemory: preferences.automatic_memory, resultLimit: preferences.result_limit === null ? 'automatic' : String(preferences.result_limit) }; },
      fields: (draft, saved) => settingsFields([
        { id: 'automaticMemory', key: keys.memory.automaticMemory, type: 'toggle', groupId: 'preferences', help: t('chat.memory.automaticMemory.help') },
        { id: 'resultLimit', key: keys.memory.resultLimit, type: 'select', groupId: 'preferences', help: t('chat.memory.preferences.limitHelp'), options: [
          { value: 'automatic', label: t('chat.memory.preferences.adminDefault', { count: memoryDefault }) },
          ...Array.from({ length: 20 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
        ] },
      ], draft, saved, t),
      write: async (id, value, active) => {
        guard(); if (!active()) throw new Error('settings_scope_changed');
        const patch = id === 'automaticMemory' ? { automatic_memory: value as boolean } : id === 'resultLimit' ? { result_limit: value === 'automatic' ? null : Number(value) } : null;
        if (!patch) throw new Error('invalid_setting_field');
        const result = await api.patchMemoryPreferences(patch); if (active()) cache('memoryPreferences', result);
        return id === 'automaticMemory' ? result.preferences.automatic_memory : result.preferences.result_limit === null ? 'automatic' : String(result.preferences.result_limit);
      },
    },
    browser: {
      groups: () => [group('permissions', 'settings.browser.confirmationsTitle'), group('typing', 'settings.browser.typingTitle')], links: () => [],
      read: async () => { const { settings } = await read<Awaited<ReturnType<typeof api.getUiSettings>>>('ui'); guard(); patchUser({ ui_settings: settings });
        return { autoOpen: settings.browser_confirm_open === false, autoClick: settings.browser_confirm_click === false,
          autoFill: settings.browser_confirm_fill === false, humanTyping: settings.browser_human_typing !== false }; },
      fields: (draft, saved) => settingsFields(Object.entries(keys.browser).map(([id, key]) => ({ id, key, type: 'toggle' as const,
        groupId: id === 'humanTyping' ? 'typing' : 'permissions', help: t(key + 'Help') + (id === 'autoFill' ? ' ' + t('settings.browser.sensitiveFieldsNote') : '') })), draft, saved, t),
      write: async (id, value, active) => {
        guard(); if (!active()) throw new Error('settings_scope_changed');
        const mapping: Record<string, 'browser_confirm_open' | 'browser_confirm_click' | 'browser_confirm_fill' | 'browser_human_typing'> = {
          autoOpen: 'browser_confirm_open', autoClick: 'browser_confirm_click', autoFill: 'browser_confirm_fill', humanTyping: 'browser_human_typing',
        };
        const key = mapping[id]; if (!key || typeof value !== 'boolean') throw new Error('invalid_setting_field');
        const result = await saveAppUiSettings({ [key]: id === 'humanTyping' ? value : !value }, () => current() && active());
        if (active()) { cache('ui', { settings: result.settings }); patchUser({ ui_settings: result.settings }); }
        return id === 'humanTyping' ? result.settings[key] !== false : result.settings[key] === false;
      },
    },
    voice: {
      groups: () => [group('activation', 'settings.voice.activation.title'), group('recognition', 'settings.voice.recognitionTitle'), group('synthesis', 'settings.voice.synthesisTitle')],
      links: () => [],
      actions: (draft, saved, running) => [
        { id: 'previewVoice', label: t('settings.voice.preview'), active: running === 'previewVoice',
          disabled: Boolean(running) || !['piper', 'builtin', 'cartesia'].includes(String(draft.modelId))
            || !voiceOptions(draft.modelId).some(voice => voice.value === draft.voiceId)
            || settingsFields([{ id: 'volume', key: keys.voice.volume, type: 'number', groupId: 'synthesis', min: 0, max: 1, step: 0.05 }], draft, saved, t).some(field => field.error) },
        { id: 'stopPreview', label: t('interactivePreview.stop'), active: false, disabled: running !== 'previewVoice' },
      ],
      run: async (id, draft, signal) => {
        guard();
        if (id === 'stopPreview') { ttsStopPreview(); return; }
        if (id !== 'previewVoice') throw new Error('invalid_setting_action');
        await ttsPreview(String(draft.modelId), String(draft.voiceId), { volume: Number(draft.volume), signal, throwOnError: true });
      },
      read: async () => {
        guard();
        const [, remote, status] = await Promise.allSettled([fetchPiperVoiceList(), fetchRemoteTtsProviders(true), api.fetchTranscriptionStatus()]);
        guard();
        // A failed server must not disable local controls or leak a previous server's cached providers.
        voices = [...getTtsModels().filter(model => model.id === 'piper' || model.id === 'builtin'), ...(remote.status === 'fulfilled' ? remote.value : [])];
        serverRecognition = status.status === 'fulfilled' && status.value.available;
        const wake = getWakeWordConfig();
        return { ...getTtsSettings(), recognitionSource: getSpeechRecognitionSource(), recognitionLanguage: getSpeechRecognitionLanguage(),
          wakeEnabled: getWakeWordEnabled(), wakeSensitivity: wake.sensitivity,
          ...Object.fromEntries(WAKE_WORD_CHOICES.map(word => [`wake_${word.id}`, wake.words.includes(word.id)])) };
      },
      fields: (draft, saved) => settingsFields([
        { id: 'wakeEnabled', key: keys.voice.wakeEnabled, type: 'toggle', groupId: 'activation', help: t('settings.voice.activation.help') },
        { id: 'wakeSensitivity', key: keys.voice.wakeSensitivity, type: 'number', groupId: 'activation', min: 0, max: 100, step: 5,
          visible: draft.wakeEnabled === true, help: t('settings.voice.activation.sensitivityHelp') },
        ...WAKE_WORD_CHOICES.map(word => ({ id: `wake_${word.id}`, key: word.label, type: 'toggle' as const, groupId: 'activation', visible: draft.wakeEnabled === true,
          validate: (value: SettingValue) => typeof value === 'boolean' && (draft.wakeEnabled !== true || WAKE_WORD_CHOICES.some(item => draft[`wake_${item.id}`] === true)) })),
        { id: 'recognitionSource', key: keys.voice.recognitionSource, type: 'select', groupId: 'recognition',
          help: t('settings.voice.recognitionSourceHint') + (serverRecognition ? '' : ' ' + t('settings.voice.recognitionSourceServerUnavailable')), options: [
            { value: 'local', label: t('settings.voice.recognitionSourceLocal') },
            { value: 'server', label: t('settings.voice.recognitionSourceServer'), disabled: !serverRecognition },
          ] },
        { id: 'recognitionLanguage', key: keys.voice.recognitionLanguage, type: 'select', groupId: 'recognition', options: keepUnavailable([
          { value: 'auto', label: t('settings.voice.recognitionAuto') }, ...SUPPORTED_LANGUAGES.map(value => ({ value, label: getLanguageDisplayName(value) })),
        ], saved.recognitionLanguage) },
        { id: 'modelId', key: keys.voice.modelId, type: 'select', groupId: 'synthesis', options: keepUnavailable(voices.map(model => ({ value: model.id, label: model.name, disabled: !model.voices.length })), saved.modelId) },
        { id: 'voiceId', key: keys.voice.voiceId, type: 'select', groupId: 'synthesis', options: draft.modelId === saved.modelId ? keepUnavailable(voiceOptions(draft.modelId), saved.voiceId) : voiceOptions(draft.modelId) },
        ...(['volume', 'sfxVolume'] as const).map(id => ({ id, key: keys.voice[id], type: 'number' as const, groupId: 'synthesis', min: 0, max: 1, step: 0.05 })),
      ], draft, saved, t),
      edit: (draft, id, value) => id === 'modelId' ? { ...draft, modelId: value,
        voiceId: voiceOptions(value).some(voice => voice.value === draft.voiceId) ? draft.voiceId : voiceOptions(value)[0]?.value ?? '' } : { ...draft, [id]: value },
      write: async (id, value, active, draft) => {
        guard(); if (!active()) throw new Error('settings_scope_changed');
        if (id === 'wakeEnabled' || id === 'wakeSensitivity' || id.startsWith('wake_')) {
          if (id !== 'wakeEnabled' || value === true) setWakeWordConfig({ sensitivity: Number(draft.wakeSensitivity), words: WAKE_WORD_CHOICES.filter(word => draft[`wake_${word.id}`] === true).map(word => word.id) });
          if (id === 'wakeEnabled') setWakeWordEnabled(value === true);
        }
        else if (id === 'recognitionSource') setSpeechRecognitionSource(value as 'local' | 'server');
        else if (id === 'recognitionLanguage') setSpeechRecognitionLanguage(value as SpeechRecognitionLanguage);
        else {
          const settings = getTtsSettings();
          if (id === 'modelId' || id === 'voiceId') setTtsSettings({ ...settings, modelId: String(draft.modelId), voiceId: String(draft.voiceId) });
          else if (id === 'volume' || id === 'sfxVolume') setTtsSettings({ ...settings, [id]: Number(value) });
          else throw new Error('invalid_setting_field');
        }
        return id === 'volume' || id === 'sfxVolume' || id === 'wakeSensitivity' ? Number(value) : value;
      },
    },
    account: {
      groups: () => [group('profile', 'settings.sections.account')],
      links: () => [],
      read: async () => { guard(); const user = await api.fetchMe(); guard(); if (user.id !== userId) throw new Error('settings_scope_changed');
        patchUser({ name: user.name, timezone_offset: user.timezone_offset, timezone_confirmed: user.timezone_confirmed });
        return { name: user.name ?? '', timezone: user.timezone_confirmed && Number.isFinite(user.timezone_offset) ? String(user.timezone_offset) : 'auto' }; },
      fields: (draft, saved) => settingsFields([
        { id: 'name', key: keys.account.name, groupId: 'profile', type: 'text', maxLength: 500,
          validate: value => value === saved.name || typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= 500 },
        { id: 'timezone', key: keys.account.timezone, groupId: 'profile', type: 'select', help: t('settings.account.timezoneHelp'),
          options: [...(saved.timezone === 'auto' ? [{ value: 'auto', label: t('settings.account.timezoneDevice'), disabled: true }] : []),
            ...Array.from({ length: 105 }, (_, index) => { const offset = -12 + index / 4, absolute = Math.abs(offset);
              return { value: String(offset), label: `UTC${offset < 0 ? '-' : '+'}${String(Math.floor(absolute)).padStart(2, '0')}:${String(Math.round(absolute % 1 * 60)).padStart(2, '0')}` }; })] },
      ], draft, saved, t),
      write: async (id, value, active) => {
        guard(); if (!active()) throw new Error('settings_scope_changed');
        if (id === 'name') { const result = await api.setUserName(String(value).trim()); if (active()) patchUser({ name: result.name }); return result.name; }
        if (id === 'timezone') { const result = await api.setUserTimezone(Number(value));
          if (active()) patchUser({ timezone_offset: result.timezone_offset, timezone_confirmed: result.timezone_confirmed }); return String(result.timezone_offset); }
        throw new Error('invalid_setting_field');
      },
    },
    limits: {
      groups: () => [group('tokens', 'settings.sections.limits'), group('browser', 'settings.app.layout.webTitle')],
      links: () => [],
      refreshAfterSave: true,
      read: async () => { const [ctx, attachment, browser] = await Promise.all([read<api.ContextTokenLimit>('context'), read<api.AttachmentTokenLimit>('attachment'), read<Awaited<ReturnType<typeof settingsReads.desktopBrowser>>>('desktopBrowser')]);
        guard(); contextCap = ctx.max_context_tokens_limit;
        return { contextTokens: ctx.max_context_tokens, attachmentTokens: attachment.attachment_max_tokens,
          browserConcurrency: browser.concurrency, desktopSearch: browser.searchEnabled, desktopReader: browser.readerEnabled }; },
      fields: (draft, saved) => {
        const attachmentCap = Number.isFinite(Number(draft.contextTokens)) ? Math.max(0, Math.floor(Number(draft.contextTokens) * 0.9)) : 0;
        return settingsFields([
          { id: 'browserConcurrency', key: keys.limits.browserConcurrency, groupId: 'browser', type: 'number', min: 1, max: 6, step: 1,
            help: t('settings.app.layout.desktopBrowserConcurrencyHelp') },
          { id: 'desktopSearch', key: keys.limits.desktopSearch, groupId: 'browser', type: 'toggle', help: t('settings.app.layout.desktopSearchHelp') },
          { id: 'desktopReader', key: keys.limits.desktopReader, groupId: 'browser', type: 'toggle', help: t('settings.app.layout.desktopReaderHelp') },
          { id: 'contextTokens', key: keys.limits.contextTokens, groupId: 'tokens', type: 'number', min: 1000, max: contextCap, step: 1,
            help: t('settings.app.contextLimitHelp', { max: (contextCap / 1000).toFixed(0) }) },
          { id: 'attachmentTokens', key: keys.limits.attachmentTokens, groupId: 'tokens', type: 'number', min: 0, max: attachmentCap, step: 1,
            help: t('settings.app.attachmentLimitHelp', { max: (attachmentCap / 1000).toFixed(0) }),
            validate: value => { const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
              return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 0 && (numeric === saved.attachmentTokens || numeric <= attachmentCap); } },
        ], draft, saved, t);
      },
      write: async (id, value, active) => {
        guard(); if (!active()) throw new Error('settings_scope_changed');
        if (id === 'browserConcurrency' || id === 'desktopSearch' || id === 'desktopReader') {
          const previous = await window.electronAPI.getDesktopBrowserSettings();
          guard(); if (!active()) throw new Error('settings_scope_changed');
          const key = id === 'browserConcurrency' ? 'concurrency' : id === 'desktopSearch' ? 'searchEnabled' : 'readerEnabled';
          const result = await window.electronAPI.setDesktopBrowserSettings({ ...previous, [key]: id === 'browserConcurrency' ? Number(value) : value });
          if (active()) cache('desktopBrowser', result); return result[key];
        }
        if (id === 'contextTokens') { const result = await api.setContextTokenLimit(Number(value)); if (active()) {
          cache('context', result); await client.invalidateQueries({ queryKey: ['settings', base, userId, 'attachment'] });
        } return result.max_context_tokens; }
        if (id === 'attachmentTokens') { const result = await api.setAttachmentTokenLimit(Number(value)); if (active()) cache('attachment', result); return result.attachment_max_tokens; }
        throw new Error('invalid_setting_field');
      },
    },
    agents: {
      groups: () => [group('defaults', 'settings.sections.agents')],
      links: () => [],
      read: async () => { const [models, model, reasoning] = await Promise.all([
        read<Awaited<ReturnType<typeof api.getModels>>>('models'), read<Awaited<ReturnType<typeof api.getSubagentModel>>>('agentModel'), read<Awaited<ReturnType<typeof api.getSubagentReasoningLevel>>>('agentReasoning'),
      ]); guard(); agentModels = models.models; autoReasoning = models.auto_reasoning_levels ?? [];
        patchUser({ subagent_model: model.subagent_model, subagent_reasoning_level: reasoning.reasoning_level });
        return { model: model.subagent_model ?? '', reasoning: reasoning.reasoning_level ?? '' }; },
      fields: (draft, saved) => settingsFields([
        { id: 'model', key: keys.agents.model, groupId: 'defaults', type: 'select', options: keepUnavailable([
          { value: '', label: t('settings.reasoning.auto') }, ...agentModels.map(model => ({ value: model.id, label: model.name })),
        ], saved.model) },
        { id: 'reasoning', key: keys.agents.reasoning, groupId: 'defaults', type: 'select', options: [
          { value: '', label: t('settings.reasoning.auto') }, ...agentReasoning(draft.model).map(value => {
            const key = value === 'none' ? 'settings.reasoning.off' : `settings.reasoning.${value === 'xhigh' ? 'max' : value}Short`;
            const label = t(key); return { value, label: label === key ? value : label };
          }),
        ] },
      ], draft, saved, t),
      edit: (draft, id, value) => id === 'model' ? { ...draft, model: value, reasoning: agentReasoning(value).includes(draft.reasoning as api.ReasoningLevel) ? draft.reasoning : '' } : { ...draft, [id]: value },
      write: async (id, value, active) => {
        guard(); if (!active()) throw new Error('settings_scope_changed');
        if (id === 'model') { const result = await api.setSubagentModel(value ? String(value) : null); if (active()) { cache('agentModel', result); patchUser({ subagent_model: result.subagent_model }); } return result.subagent_model ?? ''; }
        if (id === 'reasoning') { const result = await api.setSubagentReasoningLevel(value ? value as api.ReasoningLevel : null); if (active()) { cache('agentReasoning', result); patchUser({ subagent_reasoning_level: result.reasoning_level }); } return result.reasoning_level ?? ''; }
        throw new Error('invalid_setting_field');
      },
    },
  };
}
