import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { PromptSelector } from './PromptSelector';
import { getTtsModels, getTtsSettings, setTtsSettings, ttsPreview, ttsStopPreview, getVoicesForModel, fetchCartesiaVoiceList } from '../lib/tts';
import type { TtsSettings } from '../lib/tts';
import { Select } from './Select';
import type { SelectOption } from './Select';
import Slider from './Slider';
import Checkbox from './Checkbox';
import { MacroSettings } from './MacroSettings';
import { ServerSettings } from './ServerSettings';
import { RunbookSettings } from './RunbookSettings';
import { SshKeySettings } from './SshKeySettings';
import { SmartHomeSettings } from './SmartHomeSettings';
import { PCSettings } from './PCSettings';
import s from './SettingsModal.module.scss';
import chatS from '../pages/ChatPage.module.scss';

type Props = {
  onClose: () => void;
};

type Section = 'account' | 'prompt' | 'voice' | 'app' | 'macros' | 'pc' | 'servers' | 'runbooks' | 'sshkeys' | 'smart_home' | 'restrictions' | 'models';

const CUSTOM_PROMPT_ID = -1;

const ZOOM_STEP_PCT = 5;
const ZOOM_MIN_PCT = 40;
const ZOOM_MAX_PCT = 200;

const REASONING_LEVEL_LABELS: Record<string, string> = {
  null: 'Авто',
  none: 'Выкл',
  minimal: 'Мин',
  low: 'Низк',
  medium: 'Ср',
  high: 'Выс',
  xhigh: 'Макс',
};

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
};

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'account', label: 'Аккаунт' },
  { key: 'prompt', label: 'Промпт' },
  { key: 'voice', label: 'Голос' },
  { key: 'macros', label: 'Макросы' },
  { key: 'pc', label: 'Управление ПК' },
  { key: 'servers', label: 'Серверы' },
  { key: 'runbooks', label: 'Инструкции' },
  { key: 'sshkeys', label: 'SSH-ключи' },
  { key: 'smart_home', label: 'Умный дом' },
  { key: 'restrictions', label: 'Ограничения' },
  { key: 'models', label: 'Модели' },
  { key: 'app', label: 'Приложение' },
];

// Electron uses logarithmic zoom: zoomFactor = 1.2^level
function zoomLevelToPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100);
}

function percentToZoomLevel(pct: number): number {
  return Math.log(pct / 100) / Math.log(1.2);
}

function clampZoomPct(pct: number): number {
  const snapped = Math.round(pct / ZOOM_STEP_PCT) * ZOOM_STEP_PCT;
  return Math.min(ZOOM_MAX_PCT, Math.max(ZOOM_MIN_PCT, snapped));
}

export function SettingsModal({ onClose }: Props) {
  const { user, setUser } = useAuth();
  const [section, setSection] = useState<Section>('account');

  // Account
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Prompt
  const [prompts, setPrompts] = useState<api.PromptInfo[]>([]);
  const [customPrompts, setCustomPrompts] = useState<api.CustomPromptInfo[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState<number | null>(null);
  const [customContent, setCustomContent] = useState('');
  const [promptName, setPromptName] = useState('');
  const [promptDesc, setPromptDesc] = useState('');
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptDeleting, setPromptDeleting] = useState(false);

  // App zoom (stored as honest percentages)
  const [zoomPct, setZoomPct] = useState(100);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomInputValue, setZoomInputValue] = useState('100');

  // Voice / TTS
  const [ttsModels, setTtsModels] = useState(() => getTtsModels());
  const [ttsSettings, setTtsSettingsState] = useState<TtsSettings>(() => getTtsSettings());
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [cartesiaLoading, setCartesiaLoading] = useState(false);

  // Refresh TTS models when voice section opens
  // If cartesia voices are empty (not cached), fetch from server
  useEffect(() => {
    if (section === 'voice') {
      const models = getTtsModels();
      const cartesiaModel = models.find(m => m.id === 'cartesia');
      if (ttsSettings.modelId === 'cartesia' && (!cartesiaModel || cartesiaModel.voices.length === 0)) {
        setCartesiaLoading(true);
        fetchCartesiaVoiceList().then(() => {
          setTtsModels(getTtsModels());
          setCartesiaLoading(false);
        }).catch(() => setCartesiaLoading(false));
      } else {
        setTtsModels(models);
      }
    }
  }, [section]);

  const [coreMemory, setCoreMemory] = useState('');
  const [coreMemorySaving, setCoreMemorySaving] = useState(false);

  // Feature flags (restrictions)
  const [featureFlags, setFeatureFlagsState] = useState<api.FeatureFlags>({
    disable_memory_write: false,
    disable_pc_control_lite: false,
    disable_pc_control_full: false,
    disable_pc_commands: false,
    disable_internet: false,
    disable_personal: false,
    disable_specialized_subagents: false,
    disable_adhoc_subagents: false,
  });
  const [flagsLoading, setFlagsLoading] = useState(false);
  const [flagsSaving, setFlagsSaving] = useState(false);

  // Models (per-model generation settings)
  const [modelsCatalog, setModelsCatalog] = useState<api.ModelCatalogEntry[]>([]);
  const [modelSettingsMap, setModelSettingsMap] = useState<api.ModelSettingsMap>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsSavingId, setModelsSavingId] = useState<string | null>(null);

  // UI settings (app tab)
  const [uiSettings, setUiSettingsState] = useState<api.UiSettings>({ show_tokens: true });
  const [uiSettingsSaving, setUiSettingsSaving] = useState(false);
  const [subagentModel, setSubagentModelState] = useState<string | null>(null);
  const [subagentModelSaving, setSubagentModelSaving] = useState(false);
  const [subagentReasoningLevel, setSubagentReasoningLevelState] = useState<api.ReasoningLevel | null>(null);
  const [subagentReasoningSaving, setSubagentReasoningSaving] = useState(false);
  const [autoReasoningLevels, setAutoReasoningLevels] = useState<api.ReasoningLevel[]>([]);
  const [contextTokenLimit, setContextTokenLimitState] = useState<api.ContextTokenLimit | null>(null);
  const [contextTokenLimitSaving, setContextTokenLimitSaving] = useState(false);
  const [attachmentTokenLimit, setAttachmentTokenLimitState] = useState<api.AttachmentTokenLimit | null>(null);
  const [attachmentTokenLimitSaving, setAttachmentTokenLimitSaving] = useState(false);

  // Load account data
  useEffect(() => {
    if (user) {
      setNameValue(user.name || '');
      setCoreMemory(user.core_memory || '');
    }
  }, [user]);

  // Refresh core memory from server when account tab opens
  useEffect(() => {
    if (section === 'account') {
      api.apiFetch('/api/v1/auth/me')
        .then((res: any) => {
          setCoreMemory(res.user.core_memory || '');
          if (user) {
            const updated = { ...user, core_memory: res.user.core_memory || '' };
            setUser(updated);
            localStorage.setItem('chatter_user', JSON.stringify(updated));
          }
        })
        .catch(() => {});
    }
  }, [section]);

  // Load feature flags when restrictions tab opens
  useEffect(() => {
    if (section === 'restrictions') {
      setFlagsLoading(true);
      api.getFeatureFlags()
        .then((res) => setFeatureFlagsState(res.flags))
        .catch(() => {})
        .finally(() => setFlagsLoading(false));
    }
  }, [section]);

  // Load models catalog + per-model settings when models tab opens
  useEffect(() => {
    if (section === 'models') {
      setModelsLoading(true);
      Promise.all([
        api.getModels().catch(() => null),
        api.getModelSettings().catch(() => null),
      ]).then(([catRes, setRes]) => {
        if (catRes) setModelsCatalog(catRes.models);
        if (setRes) setModelSettingsMap(setRes.model_settings);
      }).finally(() => setModelsLoading(false));
    }
  }, [section]);

  // Load UI settings when app tab opens
  useEffect(() => {
    if (section === 'app') {
      api.getUiSettings()
        .then((res) => setUiSettingsState(res.settings))
        .catch(() => {});
      api.getModels()
        .then((res) => {
          setModelsCatalog(res.models);
          if (res.auto_reasoning_levels) setAutoReasoningLevels(res.auto_reasoning_levels);
        })
        .catch(() => {});
      api.getSubagentModel()
        .then((res) => setSubagentModelState(res.subagent_model))
        .catch(() => {});
      api.getSubagentReasoningLevel()
        .then((res) => setSubagentReasoningLevelState(res.reasoning_level))
        .catch(() => {});
      api.getContextTokenLimit()
        .then((res) => setContextTokenLimitState(res))
        .catch(() => {});
      api.getAttachmentTokenLimit()
        .then((res) => setAttachmentTokenLimitState(res))
        .catch(() => {});
    }
  }, [section]);

  const handleToggleShowTokens = async () => {
    const newValue = !(uiSettings.show_tokens !== false);
    const prev = uiSettings;
    setUiSettingsState({ show_tokens: newValue });
    setUiSettingsSaving(true);
    try {
      const res = await api.setUiSettings({ show_tokens: newValue });
      setUiSettingsState(res.settings);
      // Обновляем user в AuthProvider чтобы ChatPage сразу перерисовался
      if (user) {
        setUser({ ...user, ui_settings: res.settings });
      }
    } catch {
      setUiSettingsState(prev); // rollback
      toast.error('Не удалось сохранить настройку');
    } finally {
      setUiSettingsSaving(false);
    }
  };

  const handleToggleDiceRoll = async () => {
    const newValue = !uiSettings.dice_roll_enabled;
    const prev = uiSettings;
    setUiSettingsState({ dice_roll_enabled: newValue });
    setUiSettingsSaving(true);
    try {
      const res = await api.setUiSettings({ dice_roll_enabled: newValue });
      setUiSettingsState(res.settings);
      if (user) {
        setUser({ ...user, ui_settings: res.settings });
      }
    } catch {
      setUiSettingsState(prev); // rollback
      toast.error('Не удалось сохранить настройку');
    } finally {
      setUiSettingsSaving(false);
    }
  };

  const handleSubagentModelChange = async (value: string) => {
    const modelId = value || null;
    const prev = subagentModel;
    setSubagentModelState(modelId);
    setSubagentModelSaving(true);
    try {
      const res = await api.setSubagentModel(modelId);
      setSubagentModelState(res.subagent_model);
      if (user) {
        setUser({ ...user, subagent_model: res.subagent_model });
      }
    } catch {
      setSubagentModelState(prev);
      toast.error('Не удалось сохранить модель субагентов');
    } finally {
      setSubagentModelSaving(false);
    }
  };

  const subagentAvailableReasoningLevels = useMemo<(api.ReasoningLevel | null)[]>(() => {
    if (subagentModel) {
      const model = modelsCatalog.find(m => m.id === subagentModel);
      if (model?.reasoning_levels) return [null, ...model.reasoning_levels];
      return [null];
    }
    return [null, ...autoReasoningLevels];
  }, [subagentModel, modelsCatalog, autoReasoningLevels]);

  const handleSubagentReasoningCommit = async () => {
    const level = subagentReasoningLevel;
    setSubagentReasoningSaving(true);
    try {
      const res = await api.setSubagentReasoningLevel(level);
      setSubagentReasoningLevelState(res.reasoning_level);
      if (user) {
        setUser({ ...user, subagent_reasoning_level: res.reasoning_level });
      }
    } catch {
      toast.error('Не удалось сохранить уровень размышления субагентов');
    } finally {
      setSubagentReasoningSaving(false);
    }
  };

  // Context token limit handler
  const TOKEN_STEPS = [5000, 10000, 20000, 30000, 60000, 128000, 256000, 512000, 1000000];

  const handleContextTokenLimitChange = (value: number) => {
    if (!contextTokenLimit) return;
    const clamped = Math.min(value, contextTokenLimit.max_context_tokens_limit);
    setContextTokenLimitState({ ...contextTokenLimit, max_context_tokens: clamped });
  };

  const handleContextTokenLimitCommit = async (value?: number) => {
    if (!contextTokenLimit) return;
    const commitValue = value ?? contextTokenLimit.max_context_tokens;
    const prev = contextTokenLimit;
    setContextTokenLimitSaving(true);
    try {
      const res = await api.setContextTokenLimit(commitValue);
      setContextTokenLimitState(res);
      // Refresh attachment limit too (hardCap depends on context tokens)
      api.getAttachmentTokenLimit().then(setAttachmentTokenLimitState).catch(() => {});
    } catch {
      setContextTokenLimitState(prev);
      toast.error('Не удалось сохранить лимит токенов');
    } finally {
      setContextTokenLimitSaving(false);
    }
  };

  // ── Attachment token limit ──
  const handleAttachmentTokenLimitChange = (value: number) => {
    if (!attachmentTokenLimit) return;
    const clamped = Math.min(value, attachmentTokenLimit.attachment_max_tokens_limit);
    setAttachmentTokenLimitState({ ...attachmentTokenLimit, attachment_max_tokens: clamped });
  };

  const handleAttachmentTokenLimitCommit = async (value?: number) => {
    if (!attachmentTokenLimit) return;
    const commitValue = value ?? attachmentTokenLimit.attachment_max_tokens;
    const prev = attachmentTokenLimit;
    setAttachmentTokenLimitSaving(true);
    try {
      const res = await api.setAttachmentTokenLimit(commitValue);
      setAttachmentTokenLimitState(res);
    } catch {
      setAttachmentTokenLimitState(prev);
      toast.error('Не удалось сохранить лимит документов');
    } finally {
      setAttachmentTokenLimitSaving(false);
    }
  };

  // Save handler for a single model's settings
  const handleSaveModelSettings = async (modelId: string, settings: api.ModelSettings) => {
    setModelsSavingId(modelId);
    try {
      const res = await api.setModelSettings(modelId, settings);
      setModelSettingsMap(res.model_settings);
    } catch {
      toast.error('Не удалось сохранить настройки модели');
    } finally {
      setModelsSavingId(null);
    }
  };

  const handleToggleFlag = async (key: keyof api.FeatureFlags) => {
    const newFlags = { ...featureFlags, [key]: !featureFlags[key] };
    setFeatureFlagsState(newFlags);
    setFlagsSaving(true);
    try {
      const res = await api.setFeatureFlags(newFlags);
      setFeatureFlagsState(res.flags);
    } catch {
      setFeatureFlagsState(featureFlags); // rollback
      toast.error('Не удалось сохранить настройки');
    } finally {
      setFlagsSaving(false);
    }
  };

  // Load zoom level on modal open
  useEffect(() => {
    window.electronAPI?.getZoomLevel().then((level) => {
      const pct = clampZoomPct(zoomLevelToPercent(level));
      setZoomPct(pct);
      setZoomInputValue(String(pct));
    });
  }, []);

  // Load prompts on modal open
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPromptsLoading(true);
      try {
        const res = await api.getPrompts();
        if (cancelled) return;
        setPrompts(res.prompts);
        setCustomPrompts(res.custom_prompts || []);
        if (res.selected_prompt_id !== null) {
          setSelectedPromptId(res.selected_prompt_id);
        } else {
          const def = res.prompts.find(p => p.is_default === 1);
          setSelectedPromptId(def ? def.id : null);
        }
        setCustomContent(res.custom_prompt_content || '');
      } catch (err) {
        console.error('Failed to load prompts:', err);
      } finally {
        if (!cancelled) setPromptsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Sync name/desc/content fields when selectedPromptId changes
  useEffect(() => {
    if (selectedPromptId !== null && selectedPromptId <= -1000) {
      const cp = customPrompts.find(p => p.id === selectedPromptId);
      if (cp) {
        setPromptName(cp.name);
        setPromptDesc(cp.description);
        setCustomContent(cp.content);
      }
    } else if (selectedPromptId === CUSTOM_PROMPT_ID) {
      // New prompt: blank fields
      setPromptName('');
      setPromptDesc('');
      setCustomContent('');
    }
  }, [selectedPromptId, customPrompts]);

  const handleSaveName = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const updated = { ...user!, name: trimmed };
      setUser(updated);
      localStorage.setItem('chatter_user', JSON.stringify(updated));
      toast.success('Имя сохранено');
    } catch (err) {
      console.error('Failed to save name:', err);
      toast.error('Не удалось сохранить имя');
    } finally {
      setSaving(false);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveName();
    }
  };

  const handleSaveCoreMemory = async () => {
    setCoreMemorySaving(true);
    try {
      await api.apiFetch('/api/v1/account/core-memory', {
        method: 'PUT',
        body: JSON.stringify({ content: coreMemory }),
      });
      const updated = { ...user!, core_memory: coreMemory };
      setUser(updated);
      localStorage.setItem('chatter_user', JSON.stringify(updated));
      toast.success('Память сохранена');
    } catch {
      toast.error('Не удалось сохранить память');
    } finally {
      setCoreMemorySaving(false);
    }
  };

  const handleSelectPrompt = async (promptId: number) => {
    setSelectedPromptId(promptId);
    setPromptSaving(true);
    try {
      await api.selectPrompt(promptId);
      if (promptId === CUSTOM_PROMPT_ID) {
        // "New prompt" — don't show success, user hasn't saved anything yet
      } else {
        toast.success('Промпт выбран');
      }
    } catch (err) {
      console.error('Failed to select prompt:', err);
      toast.error('Не удалось выбрать промпт');
    } finally {
      setPromptSaving(false);
    }
  };

  const handleSaveCustomPrompt = async () => {
    const name = promptName.trim();
    if (!name) {
      toast.error('Введите название промпта');
      return;
    }
    if (!customContent.trim()) {
      toast.error('Введите текст промпта');
      return;
    }
    setPromptSaving(true);
    try {
      if (selectedPromptId !== null && selectedPromptId <= -1000) {
        // Update existing
        await api.updateCustomPromptById(selectedPromptId, {
          name,
          description: promptDesc.trim(),
          content: customContent,
        });
        // Update local state
        setCustomPrompts(prev => prev.map(p =>
          p.id === selectedPromptId
            ? { ...p, name, description: promptDesc.trim(), content: customContent }
            : p
        ));
        toast.success('Промпт обновлён');
      } else {
        // Create new (selectedPromptId === -1 or null)
        const res = await api.createCustomPrompt({
          name,
          description: promptDesc.trim(),
          content: customContent,
        });
        const newId = res.prompt_id;
        // Add to local state + select it
        setCustomPrompts(prev => [...prev, {
          id: newId,
          name,
          description: promptDesc.trim(),
          content: customContent,
        }]);
        setSelectedPromptId(newId);
        toast.success('Промпт создан и выбран');
      }
    } catch (err) {
      console.error('Failed to save custom prompt:', err);
      toast.error('Не удалось сохранить промпт');
    } finally {
      setPromptSaving(false);
    }
  };

  const handleDeleteCustomPrompt = async () => {
    if (selectedPromptId === null || selectedPromptId > -1000) return;
    setPromptDeleting(true);
    try {
      await api.deleteCustomPrompt(selectedPromptId);
      const deletedId = selectedPromptId;
      setCustomPrompts(prev => prev.filter(p => p.id !== deletedId));
      // Reset to default
      const def = prompts.find(p => p.is_default === 1);
      const fallbackId = def ? def.id : null;
      setSelectedPromptId(fallbackId);
      if (fallbackId !== null) {
        try { await api.selectPrompt(fallbackId); } catch { /* non-critical */ }
      }
      toast.success('Промпт удалён');
    } catch (err) {
      console.error('Failed to delete custom prompt:', err);
      toast.error('Не удалось удалить промпт');
    } finally {
      setPromptDeleting(false);
    }
  };

  const applyZoom = async (newPct: number) => {
    setZoomPct(newPct);
    setZoomInputValue(String(newPct));
    await window.electronAPI?.setZoomLevel(percentToZoomLevel(newPct));
  };

  const handleZoomChange = (deltaPct: number) => {
    applyZoom(clampZoomPct(zoomPct + deltaPct));
  };

  const handleZoomInputBlur = () => {
    setZoomEditing(false);
    const num = Number(zoomInputValue.replace('%', '').trim());
    if (!Number.isFinite(num)) {
      setZoomInputValue(String(zoomPct));
      return;
    }
    applyZoom(clampZoomPct(num));
  };

  const handleZoomInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  // ── Voice handlers ──

  const voiceOptions: SelectOption[] = useMemo(() => {
    return getVoicesForModel(ttsSettings.modelId).map((v) => ({
      value: v.id,
      label: v.name,
      hint: v.lang,
    }));
  }, [ttsSettings.modelId]);

  const modelOptions: SelectOption[] = useMemo(() => {
    return ttsModels.map((m) => ({
      value: m.id,
      label: m.name,
    }));
  }, [ttsModels]);

  const handleModelChange = (modelId: string) => {
    if (modelId === 'cartesia') {
      // Load voices from server
      setCartesiaLoading(true);
      fetchCartesiaVoiceList().then(() => {
        setTtsModels(getTtsModels()); // refresh models with updated cartesia voices
        const voices = getVoicesForModel('cartesia');
        const newSettings: TtsSettings = {
          modelId,
          voiceId: voices.length > 0 ? voices[0].id : '',
          volume: ttsSettings.volume,
          sfxVolume: ttsSettings.sfxVolume,
        };
        setTtsSettingsState(newSettings);
        setTtsSettings(newSettings);
        setCartesiaLoading(false);
      }).catch(() => {
        setCartesiaLoading(false);
        toast.error('Не удалось загрузить голоса Cartesia');
      });
      setPreviewPlaying(false);
      return;
    }

    const voices = getVoicesForModel(modelId);
    const newSettings: TtsSettings = {
      modelId,
      voiceId: voices.length > 0 ? voices[0].id : '',
      volume: ttsSettings.volume,
      sfxVolume: ttsSettings.sfxVolume,
    };
    setTtsSettingsState(newSettings);
    setTtsSettings(newSettings);
    setPreviewPlaying(false);
  };

  const handleVoiceChange = (voiceId: string) => {
    const newSettings = { ...ttsSettings, voiceId };
    setTtsSettingsState(newSettings);
    setTtsSettings(newSettings);
    setPreviewPlaying(false);
  };

  const handleVolumeChange = (volume: number) => {
    const newSettings = { ...ttsSettings, volume };
    setTtsSettingsState(newSettings);
    setTtsSettings(newSettings);
  };

  const handleSfxVolumeChange = (sfxVolume: number) => {
    const newSettings = { ...ttsSettings, sfxVolume };
    setTtsSettingsState(newSettings);
    setTtsSettings(newSettings);
  };

  const handlePreview = () => {
    ttsStopPreview();
    setPreviewPlaying(false);
    setTimeout(() => {
      setPreviewPlaying(true);
      ttsPreview(ttsSettings.modelId, ttsSettings.voiceId).finally(() => {
        setPreviewPlaying(false);
      });
      // Safety net: auto-reset after 15s (first cartesia generation can be slow)
      setTimeout(() => setPreviewPlaying(false), 15000);
    }, 50);
  };

  return (
    <motion.div
      className={s.overlay}
      variants={overlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        variants={modalVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <div className={s.header}>
          <span className={s.title}>Настройки</span>
          <span className={s.versionLabel}>v{(window as any).electronAPI?.appVersion || ''}</span>
          <button className={s.closeBtn} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className={s.body}>
          {/* Left menu */}
          <div className={s.menu}>
            {SECTIONS.map((sec) => (
              <button
                key={sec.key}
                className={`${s.menuItem} ${sec.key === section ? s.menuItemActive : ''}`}
                onClick={() => setSection(sec.key)}
              >
                {sec.label}
              </button>
            ))}
          </div>

          {/* Right panel */}
          {section === 'account' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Аккаунт</div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Имя</label>
                <input
                  className={s.fieldInput}
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  placeholder="Введите имя..."
                  autoFocus
                />
              </div>
              <button
                className={s.saveBtn}
                onClick={handleSaveName}
                disabled={saving || !nameValue.trim()}
              >
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>

              <div className={s.macroFormDivider} />

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Горячая память</label>
                <span className={s.fieldLabel} style={{ marginTop: '-4px', display: 'block' }}>
                  То, что ИИ всегда помнит о вас. Заполняется автоматически, но вы можете редактировать вручную.
                </span>
                <textarea
                  className={s.textareaInput}
                  value={coreMemory}
                  onChange={(e) => setCoreMemory(e.target.value.slice(0, 800))}
                  placeholder="Имя, город, работа, предпочтения..."
                  rows={5}
                  maxLength={800}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <button
                    className={s.saveBtn}
                    onClick={handleSaveCoreMemory}
                    disabled={coreMemorySaving}
                  >
                    {coreMemorySaving ? 'Сохранение...' : 'Сохранить'}
                  </button>
                  <span style={{ fontSize: '11px', color: coreMemory.length > 700 ? '#e74c3c' : 'var(--text-hint)' }}>
                    {coreMemory.length} / 800
                  </span>
                </div>
              </div>
            </div>
          )}

          {section === 'prompt' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Промпт</div>

              {promptsLoading ? (
                <div className={s.promptLoading}>Загрузка...</div>
              ) : (
                <>
                  <div className={s.fieldGroup}>
                    <label className={s.fieldLabel}>Стиль общения</label>
                    <PromptSelector
                      options={[
                        ...prompts.map(p => ({ id: p.id, name: p.name, description: p.description, kind: 'default' as const })),
                        ...customPrompts.map(p => ({ id: p.id, name: p.name, description: p.description, kind: 'custom' as const })),
                      ]}
                      value={selectedPromptId}
                      onChange={handleSelectPrompt}
                      disabled={promptSaving}
                      maxVisibleItems={5}
                    />
                  </div>

                  {(selectedPromptId === CUSTOM_PROMPT_ID || (selectedPromptId !== null && selectedPromptId <= -1000)) && (
                    <div className={s.fieldGroup}>
                      <label className={s.fieldLabel}>
                        {selectedPromptId === CUSTOM_PROMPT_ID ? 'Новый промпт' : 'Редактирование промпта'}
                      </label>
                      <input
                        className={s.fieldInput}
                        value={promptName}
                        onChange={(e) => setPromptName(e.target.value.slice(0, 80))}
                        placeholder="Название (например: «Саркастичный помощник»)"
                        maxLength={80}
                      />
                      <input
                        className={s.fieldInput}
                        value={promptDesc}
                        onChange={(e) => setPromptDesc(e.target.value.slice(0, 200))}
                        placeholder="Короткое описание (необязательно)"
                        maxLength={200}
                      />
                      <textarea
                        className={s.textareaInput}
                        value={customContent}
                        onChange={(e) => setCustomContent(e.target.value.slice(0, 10000))}
                        placeholder="Текст промпта..."
                        rows={6}
                        maxLength={10000}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            className={s.saveBtn}
                            onClick={handleSaveCustomPrompt}
                            disabled={promptSaving}
                          >
                            {promptSaving ? 'Сохранение...' : (selectedPromptId === CUSTOM_PROMPT_ID ? 'Создать' : 'Сохранить')}
                          </button>
                          {selectedPromptId !== null && selectedPromptId <= -1000 && (
                            <button
                              className={s.deleteBtn}
                              onClick={handleDeleteCustomPrompt}
                              disabled={promptDeleting}
                              style={{ color: '#e74c3c' }}
                            >
                              {promptDeleting ? 'Удаление...' : 'Удалить'}
                            </button>
                          )}
                        </div>
                        <span style={{ fontSize: '11px', color: customContent.length >= 10000 ? '#e74c3c' : 'var(--text-hint)' }}>
                          {customContent.length} / 10000
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {section === 'voice' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Голос</div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Модель озвучки</label>
                <Select
                  options={modelOptions}
                  value={ttsSettings.modelId}
                  onChange={handleModelChange}
                  placeholder="Выберите модель..."
                />
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Голос</label>
                <div className={s.voiceRow}>
                  <div className={s.voiceSelect}>
                    {cartesiaLoading ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>Загрузка голосов...</div>
                    ) : (
                      <Select
                        options={voiceOptions}
                        value={ttsSettings.voiceId}
                        onChange={handleVoiceChange}
                        placeholder="Выберите голос..."
                        searchable
                        maxVisibleItems={6}
                      />
                    )}
                  </div>
                  <button
                    className={`${s.previewBtn} ${previewPlaying ? s.previewBtnPlaying : ''}`}
                    onClick={handlePreview}
                    title="Прослушать"
                    type="button"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Громкость озвучки</label>
                <div className={s.volumeRow}>
                  <input
                    type="range"
                    className={s.volumeSlider}
                    min={0}
                    max={1}
                    step={0.05}
                    value={ttsSettings.volume}
                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  />
                  <span className={s.volumeValue}>{Math.round(ttsSettings.volume * 100)}%</span>
                </div>
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Громкость звуков</label>
                <div className={s.volumeRow}>
                  <input
                    type="range"
                    className={s.volumeSlider}
                    min={0}
                    max={1}
                    step={0.05}
                    value={ttsSettings.sfxVolume}
                    onChange={(e) => handleSfxVolumeChange(parseFloat(e.target.value))}
                  />
                  <span className={s.volumeValue}>{Math.round(ttsSettings.sfxVolume * 100)}%</span>
                </div>
              </div>
            </div>
          )}

          {section === 'macros' && (
            <MacroSettings />
          )}

          {section === 'pc' && (
            <PCSettings />
          )}

          {section === 'servers' && (
            <ServerSettings />
          )}

          {section === 'runbooks' && (
            <RunbookSettings isAdmin={user?.is_admin || 0} />
          )}

          {section === 'sshkeys' && (
            <SshKeySettings />
          )}

          {section === 'smart_home' && (
            <SmartHomeSettings />
          )}

          {section === 'restrictions' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Ограничения</div>
              <span className={s.fieldLabel} style={{ display: 'block', marginBottom: 12, marginTop: -4 }}>
                Управление доступными AI-инструментами. Изменения применяются мгновенно.
              </span>

              {flagsLoading ? (
                <div className={s.promptLoading}>Загрузка...</div>
              ) : (
                <>
                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_memory_write}
                        onChange={() => handleToggleFlag('disable_memory_write')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Запрет записи данных</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          AI не может записывать в архив (cold memory) и заметки. Горячая память и чтение остаются доступными.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_pc_control_lite}
                        onChange={() => handleToggleFlag('disable_pc_control_lite')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Ограниченный режим</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          Отключает SSH, макросы, отправку писем, создание задач. Умный дом, карты, чтение почты и виджеты остаются.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_pc_commands}
                        onChange={() => handleToggleFlag('disable_pc_commands')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Без команд на ПК</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          Отключает только выполнение команд на компьютере (execute_pc_command). SSH, макросы и чтение файловой системы остаются.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_pc_control_full}
                        onChange={() => handleToggleFlag('disable_pc_control_full')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Полная блокировка</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          Отключает всё десктопное: серверы, макросы, умный дом, почту, карты, виджеты, файловую систему, команды на ПК.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_internet}
                        onChange={() => handleToggleFlag('disable_internet')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Без интернета и генерации</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          Отключает поиск в интернете, чтение веб-страниц и генерацию изображений.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_personal}
                        onChange={() => handleToggleFlag('disable_personal')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Гостевой режим</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          AI не видит ваш промпт, профиль, архив, заметки и задачи. Общение с чистого листа.
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_specialized_subagents}
                        onChange={() => handleToggleFlag('disable_specialized_subagents')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Без специализированных субагентов</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          Отключает вызов заранее настроенных субагентов (invoke_subagent).
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={featureFlags.disable_adhoc_subagents}
                        onChange={() => handleToggleFlag('disable_adhoc_subagents')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>Без создания субагентов</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          Отключает создание субагентов на лету (spawn_subagent).
                        </div>
                      </div>
                    </label>
                  </div>
                </>
              )}
            </div>
          )}

          {section === 'models' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Настройки моделей</div>
              <span className={s.fieldLabel} style={{ display: 'block', marginBottom: 12, marginTop: -4 }}>
                Параметры генерации для каждой модели. «Авто» — использовать серверный дефолт.
              </span>

              {modelsLoading ? (
                <div className={s.promptLoading}>Загрузка...</div>
              ) : modelsCatalog.length === 0 ? (
                <div className={s.fieldLabel}>Нет кастомных моделей. Добавьте модели через MODELS_MANUAL на сервере.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {modelsCatalog.map((model) => {
                    const settings = modelSettingsMap[model.id] || {};
                    const isSaving = modelsSavingId === model.id;
                    const supported = new Set(model.supported_params || []);
                    return (
                      <div key={model.id} style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                          {model.name}
                          {isSaving && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-hint)' }}>сохранение...</span>}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {(
                            [
                              { key: 'temperature',        label: 'Temperature',        min: 0.0, max: 2.0,   step: 0.05 },
                              { key: 'top_p',              label: 'Top P',              min: 0.0, max: 1.0,   step: 0.05 },
                              { key: 'top_k',              label: 'Top K',              min: 1,   max: 100,   step: 1 },
                              { key: 'frequency_penalty',  label: 'Frequency penalty',  min: -2.0, max: 2.0,  step: 0.05 },
                              { key: 'presence_penalty',   label: 'Presence penalty',   min: -2.0, max: 2.0,  step: 0.05 },
                              { key: 'repetition_penalty', label: 'Repetition penalty', min: 1.0, max: 2.0,   step: 0.05 },
                              { key: 'max_tokens',         label: 'Max tokens',         min: 1,   max: 65536, step: 1 },
                            ] as const
                          ).filter((param) => supported.size === 0 || supported.has(param.key)).map((param) => {
                            const currentVal = settings[param.key as keyof api.ModelSettings] ?? null;
                            const useDefault = currentVal === null;
                            return (
                              <div key={param.key} className={s.modelParamRow}>
                                <Checkbox
                                  checked={useDefault}
                                  label="авто"
                                  onChange={(checked) => {
                                    const updated = { ...settings };
                                    if (checked) {
                                      delete (updated as any)[param.key];
                                    } else {
                                      (updated as any)[param.key] = param.min;
                                    }
                                    setModelSettingsMap(prev => ({ ...prev, [model.id]: updated }));
                                    handleSaveModelSettings(model.id, updated);
                                  }}
                                />
                                <Slider
                                  mode="numeric"
                                  label={param.label}
                                  min={param.min}
                                  max={param.max}
                                  step={param.step}
                                  value={currentVal}
                                  disabled={useDefault}
                                  formatValue={(v) => param.step < 1 ? v.toFixed(2) : String(v)}
                                  onChange={(v) => {
                                    const updated = { ...settings, [param.key]: v };
                                    setModelSettingsMap(prev => ({ ...prev, [model.id]: updated }));
                                  }}
                                  onCommit={() => {
                                    const finalSettings = modelSettingsMap[model.id] || {};
                                    handleSaveModelSettings(model.id, finalSettings);
                                  }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {section === 'app' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Приложение</div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Масштаб интерфейса</label>
                <div className={s.zoomControl}>
                  <button
                    className={s.zoomBtn}
                    onClick={() => handleZoomChange(-ZOOM_STEP_PCT)}
                    disabled={zoomPct <= ZOOM_MIN_PCT}
                    type="button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                  <input
                    className={s.zoomInput}
                    type="text"
                    value={zoomEditing ? zoomInputValue : `${zoomPct}%`}
                    onFocus={() => { setZoomEditing(true); setZoomInputValue(String(zoomPct)); }}
                    onChange={(e) => setZoomInputValue(e.target.value)}
                    onBlur={handleZoomInputBlur}
                    onKeyDown={handleZoomInputKeyDown}
                  />
                  <button
                    className={s.zoomBtn}
                    onClick={() => handleZoomChange(ZOOM_STEP_PCT)}
                    disabled={zoomPct >= ZOOM_MAX_PCT}
                    type="button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={uiSettings.show_tokens !== false}
                  onChange={handleToggleShowTokens}
                  label="Показывать токены"
                  disabled={uiSettingsSaving}
                />
              </div>

              <div className={s.fieldGroup}>
                <div className={chatS.modelSelector}>
                  {modelsCatalog.length > 0 && (
                    <>
                      <label className={chatS.modelLabel}>Модель субагентов:</label>
                      <div className={chatS.modelSelectWrap}>
                        <Select
                          options={[
                            { value: '', label: 'Авто', hint: 'Автоматический выбор' },
                            ...modelsCatalog.map(m => ({
                              value: m.id,
                              label: m.name,
                              hint: m.description || undefined,
                            })),
                          ]}
                          value={subagentModel || ''}
                          onChange={handleSubagentModelChange}
                          placeholder="Авто"
                          disabled={subagentModelSaving}
                        />
                      </div>
                    </>
                  )}
                  {subagentAvailableReasoningLevels.length > 1 && (
                    <div className={chatS.reasoningControl}>
                      <Slider
                        mode="discrete"
                        label="Размышление:"
                        values={subagentAvailableReasoningLevels}
                        labels={REASONING_LEVEL_LABELS}
                        value={subagentReasoningLevel}
                        onChange={(v) => setSubagentReasoningLevelState(v as api.ReasoningLevel | null)}
                        onCommit={handleSubagentReasoningCommit}
                        disabled={subagentReasoningSaving}
                      />
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  Отдельные модель и размышление для субагентов. В tool call модель режим не выбирает.
                </div>
              </div>

              {/* Context Token Limit */}
              {contextTokenLimit && (
                <div className={s.fieldGroup}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    Лимит контекста чата
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Slider
                      mode="numeric"
                      label=""
                      min={Math.min(...TOKEN_STEPS.filter(s => s <= contextTokenLimit.max_context_tokens_limit), 5000)}
                      max={contextTokenLimit.max_context_tokens_limit}
                      step={1000}
                      value={contextTokenLimit.max_context_tokens}
                      onChange={(v) => {
                        if (v !== null) handleContextTokenLimitChange(v);
                      }}
                      onCommit={handleContextTokenLimitCommit}
                      disabled={contextTokenLimitSaving}
                      formatValue={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
                    />
                    <input
                      type="number"
                      min={1000}
                      max={contextTokenLimit.max_context_tokens_limit}
                      step={1000}
                      value={contextTokenLimit.max_context_tokens}
                      disabled={contextTokenLimitSaving}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v >= 1000) handleContextTokenLimitChange(v);
                      }}
                      onBlur={() => handleContextTokenLimitCommit()}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleContextTokenLimitCommit(); }}
                      style={{
                        width: 90, padding: '4px 8px', fontSize: 12,
                        background: 'var(--bg-input)', border: '1px solid var(--border-medium)',
                        borderRadius: 6, color: 'var(--text-primary)', outline: 'none',
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                    Старые сообщения архивируются, когда контекст превышает лимит. При превышении контекст схлопывается до 50%. Максимум для тарифа: {(contextTokenLimit.max_context_tokens_limit / 1000).toFixed(0)}k токенов.
                  </div>
                  {/* Quick presets */}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {TOKEN_STEPS
                      .filter(step => step <= contextTokenLimit.max_context_tokens_limit)
                      .map(step => (
                        <button
                          key={step}
                          onClick={() => {
                            handleContextTokenLimitChange(step);
                            handleContextTokenLimitCommit(step);
                          }}
                          disabled={contextTokenLimitSaving}
                          style={{
                            padding: '3px 10px', fontSize: 11, cursor: 'pointer',
                            borderRadius: 6, border: '1px solid var(--border-medium)',
                            background: contextTokenLimit.max_context_tokens === step ? 'var(--accent)' : 'var(--bg-input)',
                            color: contextTokenLimit.max_context_tokens === step ? '#fff' : 'var(--text-body)',
                          }}
                        >
                          {step >= 1000 ? `${step / 1000}k` : step}
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {/* Attachment Token Limit */}
              {attachmentTokenLimit && (
                <div className={s.fieldGroup}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    Лимит документов
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Slider
                      mode="numeric"
                      label=""
                      min={0}
                      max={attachmentTokenLimit.attachment_max_tokens_limit}
                      step={1000}
                      value={attachmentTokenLimit.attachment_max_tokens}
                      onChange={(v) => {
                        if (v !== null) handleAttachmentTokenLimitChange(v);
                      }}
                      onCommit={handleAttachmentTokenLimitCommit}
                      disabled={attachmentTokenLimitSaving}
                      formatValue={(v) => v === 0 ? 'Авто' : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
                    />
                    <input
                      type="number"
                      min={0}
                      max={attachmentTokenLimit.attachment_max_tokens_limit}
                      step={1000}
                      value={attachmentTokenLimit.attachment_max_tokens}
                      disabled={attachmentTokenLimitSaving}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v >= 0) handleAttachmentTokenLimitChange(v);
                      }}
                      onBlur={() => handleAttachmentTokenLimitCommit()}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAttachmentTokenLimitCommit(); }}
                      style={{
                        width: 90, padding: '4px 8px', fontSize: 12,
                        background: 'var(--bg-input)', border: '1px solid var(--border-medium)',
                        borderRadius: 6, color: 'var(--text-primary)', outline: 'none',
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                    Сколько токенов из контекста может занимать содержимое прикреплённых документов. 0 = авто (90% от лимита контекста). Максимум: {(attachmentTokenLimit.attachment_max_tokens_limit / 1000).toFixed(0)}k токенов.
                  </div>
                </div>
              )}

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={Boolean(uiSettings.dice_roll_enabled)}
                  onChange={handleToggleDiceRoll}
                  label="Режим кубика (d20)"
                  disabled={uiSettingsSaving}
                />
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  Добавляет кубик d20 рядом с полем ввода. Ответы ИИ зависят от вашей удачи.
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
