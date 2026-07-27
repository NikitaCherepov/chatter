import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { diffLines } from 'diff';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { PromptSelector } from './PromptSelector';
import { getTtsModels, getTtsSettings, setTtsSettings, ttsPreview, ttsStopPreview, getVoicesForModel, fetchRemoteTtsProviders, fetchPiperVoiceList } from '../lib/tts';
import type { TtsSettings } from '../lib/tts';
import { getSpeechRecognitionLanguage, setSpeechRecognitionLanguage, type SpeechRecognitionLanguage } from '../lib/speechRecognition';
import { getWakeWordEnabled, setWakeWordEnabled as setWakeWordEnabledStorage } from '../lib/wakeWordToggle';
import { getRenderPerfLevel, setRenderPerfLevel, type RenderPerfLevel } from '../lib/renderPerf';
import { Select } from './Select';
import type { SelectOption } from './Select';
import {
  getDetectedSystemLanguage,
  getLanguageDisplayName,
  getLanguagePreference,
  isLanguagePreference,
  setLanguagePreference,
  SUPPORTED_LANGUAGES,
  type LanguagePreference,
} from '../i18n';
import Slider from './Slider';
import Checkbox from './Checkbox';
import { MacroSettings } from './MacroSettings';
import { ServerSettings } from './ServerSettings';
import { RunbookSettings } from './RunbookSettings';
import { SshKeySettings } from './SshKeySettings';
import { SmartHomeSettings } from './SmartHomeSettings';
import { MailSettings } from './MailSettings';
import { PCSettings } from './PCSettings';
import { LinkTelegramModal } from './LinkTelegramModal';
import { QuotaWidget } from './QuotaWidget';
import telegramIcon from '../assets/integrations/telegram.webp';
import s from './SettingsModal.module.scss';
import chatS from '../pages/ChatPage.module.scss';

type Props = {
  onClose: () => void;
  onAccountChanged?: () => void | Promise<void>;
  /** Called when the user changed their password or login and server tokens
   *  were revoked — the parent must force a sign-out and close the modal. */
  onAuthInvalidated?: () => void;
};

type Section = 'account' | 'connections' | 'prompt' | 'voice' | 'app' | 'limits' | 'billing' | 'macros' | 'pc' | 'servers' | 'runbooks' | 'sshkeys' | 'mail' | 'smart_home' | 'restrictions' | 'models';

const CUSTOM_PROMPT_ID = -1;

const ZOOM_STEP_PCT = 5;
const ZOOM_MIN_PCT = 40;
const ZOOM_MAX_PCT = 200;


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

const SECTIONS: { key: Section; labelKey: string }[] = [
  { key: 'account', labelKey: 'settings.sections.account' },
  { key: 'connections', labelKey: 'settings.sections.connections' },
  { key: 'prompt', labelKey: 'settings.sections.prompt' },
  { key: 'voice', labelKey: 'settings.sections.voice' },
  { key: 'macros', labelKey: 'settings.sections.macros' },
  { key: 'pc', labelKey: 'settings.sections.pc' },
  { key: 'servers', labelKey: 'settings.sections.servers' },
  { key: 'runbooks', labelKey: 'settings.sections.runbooks' },
  { key: 'sshkeys', labelKey: 'settings.sections.sshkeys' },
  { key: 'mail', labelKey: 'settings.sections.mail' },
  { key: 'smart_home', labelKey: 'settings.sections.smartHome' },
  { key: 'restrictions', labelKey: 'settings.sections.restrictions' },
  { key: 'models', labelKey: 'settings.sections.models' },
  { key: 'limits', labelKey: 'settings.sections.limits' },
  { key: 'billing', labelKey: 'settings.sections.billing' },
  { key: 'app', labelKey: 'settings.sections.app' },
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

export function SettingsModal({ onClose, onAccountChanged, onAuthInvalidated }: Props) {
  const { user, setUser } = useAuth();
  const { t, i18n } = useTranslation();
  const reasoningLevelLabels: Record<string, string> = {
    null: t('settings.reasoning.auto'),
    none: t('settings.reasoning.off'),
    minimal: t('settings.reasoning.minimalShort'),
    low: t('settings.reasoning.lowShort'),
    medium: t('settings.reasoning.mediumShort'),
    high: t('settings.reasoning.highShort'),
    xhigh: t('settings.reasoning.maxShort'),
  };
  const [section, setSection] = useState<Section>('account');

  // Account
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);
  // Password & login change — keep separate states so the two forms do not
  // interact (clearing one must not clear the other).
  const [pwdCurrent, setPwdCurrent] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loginCurrent, setLoginCurrent] = useState('');
  const [newLogin, setNewLogin] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [loginSaving, setLoginSaving] = useState(false);

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

  // AI prompt generation
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiDetail, setAiDetail] = useState<string>('medium');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGenerated, setAiGenerated] = useState<string | null>(null);
  const [aiPreferredModel, setAiPreferredModel] = useState<string | null>(null);

  // App zoom (stored as honest percentages)
  const [zoomPct, setZoomPct] = useState(100);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomInputValue, setZoomInputValue] = useState('100');

  // Voice / TTS
  const [ttsModels, setTtsModels] = useState(() => getTtsModels());
  const [ttsSettings, setTtsSettingsState] = useState<TtsSettings>(() => getTtsSettings());
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [remoteProvidersLoading, setRemoteProvidersLoading] = useState(false);
  const [piperLoading, setPiperLoading] = useState(false);
  const [recognitionLanguage, setRecognitionLanguage] = useState<SpeechRecognitionLanguage>(
    () => getSpeechRecognitionLanguage(),
  );
  const [wakeWordEnabled, setWakeWordEnabled] = useState(() => getWakeWordEnabled());

  const recognitionLanguageOptions = useMemo<SelectOption[]>(() => [
    { value: 'auto', label: t('settings.voice.recognitionAuto') },
    ...SUPPORTED_LANGUAGES.map((language) => ({ value: language, label: getLanguageDisplayName(language) })),
  ], [i18n.language, t]);

  // Refresh local voices and backend-provided cloud TTS options when voice settings open.
  useEffect(() => {
    if (section !== 'voice') return;

    let cancelled = false;
    setTtsModels(getTtsModels());
    setPiperLoading(true);
    setRemoteProvidersLoading(true);

    Promise.all([
      fetchPiperVoiceList(),
      fetchRemoteTtsProviders(true),
    ]).then(() => {
      if (cancelled) return;

      const models = getTtsModels();
      setTtsModels(models);
      setTtsSettingsState(current => {
        const selectedModel = models.find(model => model.id === current.modelId);
        const selectedVoiceExists = selectedModel?.voices.some(voice => voice.id === current.voiceId) ?? false;
        if (selectedVoiceExists) return current;

        const fallbackModel = selectedModel && selectedModel.voices.length > 0
          ? selectedModel
          : models.find(model => model.id === 'piper' && model.voices.length > 0)
            || models.find(model => model.id === 'builtin' && model.voices.length > 0);
        if (!fallbackModel) return current;

        const fallbackVoice = fallbackModel.id === 'piper'
          ? fallbackModel.voices.find(voice => voice.id === 'ruslan') || fallbackModel.voices[0]
          : fallbackModel.voices[0];
        const nextSettings = {
          ...current,
          modelId: fallbackModel.id,
          voiceId: fallbackVoice.id,
        };
        setTtsSettings(nextSettings);
        return nextSettings;
      });
    }).finally(() => {
      if (!cancelled) {
        setPiperLoading(false);
        setRemoteProvidersLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
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
  const [languagePreference, setLanguagePreferenceState] = useState<LanguagePreference>(
    () => getLanguagePreference(),
  );
  const [renderPerf, setRenderPerfState] = useState<RenderPerfLevel>(() => getRenderPerfLevel());
  const languageOptions = useMemo<SelectOption[]>(() => {
    const currentSystemLanguage = getLanguageDisplayName(getDetectedSystemLanguage());
    return [
      { value: 'system', label: t('settings.language.systemWithLanguage', { language: currentSystemLanguage }) },
      ...SUPPORTED_LANGUAGES.map((language) => ({ value: language, label: getLanguageDisplayName(language) })),
    ];
  }, [i18n.language, t]);
  const [subagentModel, setSubagentModelState] = useState<string | null>(null);
  const [subagentModelSaving, setSubagentModelSaving] = useState(false);
  const [subagentReasoningLevel, setSubagentReasoningLevelState] = useState<api.ReasoningLevel | null>(null);
  const [subagentReasoningSaving, setSubagentReasoningSaving] = useState(false);
  const [autoReasoningLevels, setAutoReasoningLevels] = useState<api.ReasoningLevel[]>([]);
  const [contextTokenLimit, setContextTokenLimitState] = useState<api.ContextTokenLimit | null>(null);
  const [contextTokenLimitSaving, setContextTokenLimitSaving] = useState(false);
  const [attachmentTokenLimit, setAttachmentTokenLimitState] = useState<api.AttachmentTokenLimit | null>(null);
  const [attachmentTokenLimitSaving, setAttachmentTokenLimitSaving] = useState(false);

  // Linked accounts
  const [linkStatus, setLinkStatus] = useState<api.LinkStatusResponse | null>(null);
  const [linkStatusLoading, setLinkStatusLoading] = useState(false);
  const [showTelegramLinkModal, setShowTelegramLinkModal] = useState(false);
  const [showTelegramUnlinkModal, setShowTelegramUnlinkModal] = useState(false);
  const [unlinkDataOwner, setUnlinkDataOwner] = useState<api.UnlinkDataOwner>('desktop');
  const [unlinkingTelegram, setUnlinkingTelegram] = useState(false);

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
    }
  }, [section]);

  useEffect(() => {
    if (section !== 'connections') return;
    setLinkStatusLoading(true);
    api.getLinkStatus()
      .then(setLinkStatus)
      .catch(() => setLinkStatus(null))
      .finally(() => setLinkStatusLoading(false));
  }, [section]);

  // Load context/document limits when the limits tab opens
  useEffect(() => {
    if (section === 'limits') {
      api.getContextTokenLimit()
        .then((res) => setContextTokenLimitState(res))
        .catch(() => {});
      api.getAttachmentTokenLimit()
        .then((res) => setAttachmentTokenLimitState(res))
        .catch(() => {});
    }
  }, [section]);

  const handleLanguagePreferenceChange = async (value: string) => {
    if (!isLanguagePreference(value)) return;

    const previousPreference = languagePreference;
    setLanguagePreferenceState(value);

    try {
      const language = await setLanguagePreference(value);
      const result = await api.setUserLanguage(language);
      if (user) {
        const updatedUser = { ...user, language: result.language };
        setUser(updatedUser);
        localStorage.setItem('chatter_user', JSON.stringify(updatedUser));
      }
    } catch {
      setLanguagePreferenceState(previousPreference);
      try {
        await setLanguagePreference(previousPreference);
      } catch {
        // The save error below is enough; keep the modal responsive.
      }
      toast.error(t('settings.toasts.saveSettingFailed'));
    }
  };

  const renderPerfOptions = useMemo<SelectOption[]>(() => [
    { value: 'low', label: t('settings.app.renderPerfLow') },
    { value: 'medium', label: t('settings.app.renderPerfMedium') },
    { value: 'high', label: t('settings.app.renderPerfHigh') },
    { value: 'ultra', label: t('settings.app.renderPerfUltra') },
  ], [t]);

  const handleRenderPerfChange = (value: string) => {
    if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'ultra') return;
    setRenderPerfState(value as RenderPerfLevel);
    setRenderPerfLevel(value as RenderPerfLevel);
    toast.success(t('settings.app.renderPerfSaved'));
  };

  const handleTelegramLinked = async () => {
    setShowTelegramLinkModal(false);
    try {
      const [freshUser, status] = await Promise.all([
        api.fetchMe(),
        api.getLinkStatus(),
      ]);
      setUser(freshUser);
      localStorage.setItem('chatter_user', JSON.stringify(freshUser));
      setLinkStatus(status);
      api.reconnectWebSocket();
      await onAccountChanged?.();
      toast.success(t('settings.connections.linked'));
    } catch {
      toast.error(t('settings.connections.refreshFailed'));
    }
  };

  const handleTelegramUnlink = async () => {
    setUnlinkingTelegram(true);
    try {
      const res = await api.unlinkTelegram(unlinkDataOwner);
      setUser(res.user);
      localStorage.setItem('chatter_user', JSON.stringify(res.user));
      setLinkStatus({ linked: false });
      setShowTelegramUnlinkModal(false);
      api.reconnectWebSocket();
      await onAccountChanged?.();
      toast.success(t('settings.connections.unlinked'));
    } catch (error: any) {
      const code = error?.code || error?.message;
      if (code === 'password_identity_required') {
        toast.error(t('settings.connections.passwordRequired'));
      } else {
        toast.error(t('settings.connections.unlinkFailed'));
      }
    } finally {
      setUnlinkingTelegram(false);
    }
  };

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
      toast.error(t('settings.toasts.saveSettingFailed'));
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
      toast.error(t('settings.toasts.saveSettingFailed'));
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
      toast.error(t('settings.toasts.saveSubagentModelFailed'));
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
      toast.error(t('settings.toasts.saveSubagentReasoningFailed'));
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
      toast.error(t('settings.toasts.saveTokenLimitFailed'));
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
      toast.error(t('settings.toasts.saveAttachmentLimitFailed'));
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
      toast.error(t('settings.toasts.saveModelSettingsFailed'));
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
      toast.error(t('settings.toasts.saveSettingsFailed'));
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
      await api.setUserName(trimmed);
      const updated = { ...user!, name: trimmed };
      setUser(updated);
      localStorage.setItem('chatter_user', JSON.stringify(updated));
      toast.success(t('settings.toasts.nameSaved'));
    } catch (err) {
      console.error('Failed to save name:', err);
      toast.error(t('settings.toasts.nameSaveFailed'));
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

  const handleChangePassword = async () => {
    if (!pwdCurrent || newPassword.length < 8) {
      toast.error(t('auth.forgot.passwordTooShort'));
      return;
    }
    setPasswordSaving(true);
    try {
      await api.apiFetch('/api/v1/user/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: pwdCurrent, new_password: newPassword }),
      });
      setPwdCurrent('');
      setNewPassword('');
      toast.success(t('settings.toasts.passwordChanged'));
      // Server revoked all tokens — must re-login.
      onAuthInvalidated?.();
    } catch (err: any) {
      const code = err?.code || err?.message;
      if (code === 'wrong_current_password') {
        toast.error(t('settings.toasts.wrongPassword'));
      } else {
        toast.error(t('settings.toasts.passwordChangeFailed'));
      }
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleChangeLogin = async () => {
    if (!loginCurrent || !newLogin.trim()) {
      toast.error(t('settings.toasts.loginRequired'));
      return;
    }
    setLoginSaving(true);
    try {
      const res = await api.apiFetch<{ ok: boolean; login: string }>('/api/v1/user/login', {
        method: 'PUT',
        body: JSON.stringify({ password: loginCurrent, new_login: newLogin.trim() }),
      });
      setLoginCurrent('');
      setNewLogin('');
      toast.success(t('settings.toasts.loginChanged', { login: res.login }));
      // Server revoked all tokens — must re-login with new login.
      onAuthInvalidated?.();
    } catch (err: any) {
      const code = err?.code || err?.message;
      if (code === 'wrong_current_password') {
        toast.error(t('settings.toasts.wrongPassword'));
      } else if (code === 'login_already_exists') {
        toast.error(t('settings.toasts.loginAlreadyExists'));
      } else if (code === 'bad_login') {
        toast.error(t('settings.toasts.badLogin'));
      } else {
        toast.error(t('settings.toasts.loginChangeFailed'));
      }
    } finally {
      setLoginSaving(false);
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
      toast.success(t('settings.toasts.memorySaved'));
    } catch {
      toast.error(t('settings.toasts.memorySaveFailed'));
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
        toast.success(t('settings.toasts.promptSelected'));
      }
    } catch (err) {
      console.error('Failed to select prompt:', err);
      toast.error(t('settings.toasts.promptSelectFailed'));
    } finally {
      setPromptSaving(false);
    }
  };

  const handleSaveCustomPrompt = async () => {
    const name = promptName.trim();
    if (!name) {
      toast.error(t('settings.toasts.enterPromptName'));
      return;
    }
    if (!customContent.trim()) {
      toast.error(t('settings.toasts.enterPromptText'));
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
        toast.success(t('settings.toasts.promptUpdated'));
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
        toast.success(t('settings.toasts.promptCreated'));
      }
    } catch (err) {
      console.error('Failed to save custom prompt:', err);
      toast.error(t('settings.toasts.promptSaveFailed'));
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
      toast.success(t('settings.toasts.promptDeleted'));
    } catch (err) {
      console.error('Failed to delete custom prompt:', err);
      toast.error(t('settings.toasts.promptDeleteFailed'));
    } finally {
      setPromptDeleting(false);
    }
  };

  const handleAiGenerate = async () => {
    const instruction = aiInstruction.trim();
    if (!instruction) {
      toast.error(t('settings.toasts.describePrompt'));
      return;
    }
    setAiGenerating(true);
    setAiGenerated(null);
    try {
      const res = await api.generatePrompt({
        instruction,
        current_content: customContent,
        detail: aiDetail as 'minimal' | 'medium' | 'detailed' | 'none',
        preferred_model: aiPreferredModel || undefined,
      });
      setAiGenerated(res.generated_prompt);
    } catch (err) {
      console.error('AI prompt generation failed:', err);
      toast.error(t('settings.toasts.promptGenerateFailed'));
    } finally {
      setAiGenerating(false);
    }
  };

  const handleAiApply = () => {
    if (aiGenerated === null) return;
    setCustomContent(aiGenerated);
    setAiGenerated(null);
    toast.success(t('settings.toasts.promptApplied'));
  };

  const handleAiDismiss = () => {
    setAiGenerated(null);
  };

  // Diff between current content and AI-generated
  const aiDiff = useMemo(() => {
    if (aiGenerated === null) return null;
    return diffLines(customContent, aiGenerated);
  }, [aiGenerated, customContent]);

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
  }, [ttsSettings.modelId, ttsModels]);

  const modelOptions: SelectOption[] = useMemo(() => {
    return ttsModels.map((m) => ({
      value: m.id,
      label: m.name,
    }));
  }, [ttsModels]);

  const selectedVoiceListLoading = ttsSettings.modelId === 'piper'
    ? piperLoading
    : !['piper', 'builtin'].includes(ttsSettings.modelId) && remoteProvidersLoading;

  const handleModelChange = (modelId: string) => {
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

  const handleRecognitionLanguageChange = (language: string) => {
    const nextLanguage = language as SpeechRecognitionLanguage;
    setRecognitionLanguage(nextLanguage);
    setSpeechRecognitionLanguage(nextLanguage);
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
          <span className={s.title}>{t('settings.title')}</span>
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
                {t(sec.labelKey)}
              </button>
            ))}
          </div>

          {/* Right panel */}
          {section === 'account' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>
                {t('settings.sections.account')}
                <span className={s.planBadge}>{(user?.plan || 'free').toUpperCase()}</span>
              </div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.account.name')}</label>
                <input
                  className={s.fieldInput}
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  placeholder={t('settings.account.namePlaceholder')}
                  autoFocus
                />
                <button
                  className={s.saveBtn}
                  onClick={handleSaveName}
                  disabled={saving || !nameValue.trim()}
                >
                  {saving ? t('common.saving') : t('common.save')}
                </button>
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.account.memory')}</label>
                <span className={s.fieldLabel} style={{ marginTop: '-4px', display: 'block' }}>
                  {t('settings.account.memoryHelp')}
                </span>
                <textarea
                  className={s.textareaInput}
                  value={coreMemory}
                  onChange={(e) => setCoreMemory(e.target.value.slice(0, 800))}
                  placeholder={t('settings.account.memoryPlaceholder')}
                  rows={5}
                  maxLength={800}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <button
                    className={s.saveBtn}
                    onClick={handleSaveCoreMemory}
                    disabled={coreMemorySaving}
                  >
                    {coreMemorySaving ? t('common.saving') : t('common.save')}
                  </button>
                  <span style={{ fontSize: '11px', color: coreMemory.length > 700 ? '#e74c3c' : 'var(--text-hint)' }}>
                    {coreMemory.length} / 800
                  </span>
                </div>
              </div>

              <div className={s.macroFormDivider} />

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('quota.title')}</label>
                <QuotaWidget variant="full" />
              </div>

              <div className={s.macroFormDivider} />

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.account.changePassword')}</label>
                <input
                  className={s.fieldInput}
                  type="password"
                  value={pwdCurrent}
                  onChange={(e) => setPwdCurrent(e.target.value)}
                  placeholder={t('settings.account.currentPassword')}
                  autoComplete="current-password"
                />
                <input
                  className={s.fieldInput}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('settings.account.newPassword')}
                  minLength={8}
                  autoComplete="new-password"
                />
                <button
                  className={s.saveBtn}
                  onClick={handleChangePassword}
                  disabled={passwordSaving || !pwdCurrent || newPassword.length < 8}
                >
                  {passwordSaving ? t('common.saving') : t('settings.account.changePassword')}
                </button>
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.account.changeLogin')}</label>
                <input
                  className={s.fieldInput}
                  type="text"
                  value={newLogin}
                  onChange={(e) => setNewLogin(e.target.value)}
                  placeholder={t('settings.account.newLogin')}
                  autoComplete="username"
                />
                <input
                  className={s.fieldInput}
                  type="password"
                  value={loginCurrent}
                  onChange={(e) => setLoginCurrent(e.target.value)}
                  placeholder={t('settings.account.currentPassword')}
                  autoComplete="current-password"
                />
                <button
                  className={s.saveBtn}
                  onClick={handleChangeLogin}
                  disabled={loginSaving || !loginCurrent || !newLogin.trim()}
                >
                  {loginSaving ? t('common.saving') : t('settings.account.changeLogin')}
                </button>
              </div>
            </div>
          )}

          {section === 'connections' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.connections')}</div>
              <div className={s.connectionsHelp}>{t('settings.connections.help')}</div>

              {linkStatusLoading ? (
                <div className={s.promptLoading}>{t('common.loading')}</div>
              ) : (
                <div className={s.connectionCard}>
                  <div className={s.connectionIconWrap}>
                    <img className={s.connectionIcon} src={telegramIcon} alt="" />
                  </div>
                  <div className={s.connectionInfo}>
                    <div className={s.connectionTitleRow}>
                      <span className={s.connectionTitle}>Telegram</span>
                      <span className={`${s.connectionStatus} ${linkStatus?.linked ? s.connectionStatusLinked : ''}`}>
                        {linkStatus?.linked
                          ? t('settings.connections.connected')
                          : t('settings.connections.notConnected')}
                      </span>
                    </div>
                    <div className={s.connectionSubtitle}>
                      {linkStatus?.linked
                        ? (linkStatus.tg_username
                          ? `${linkStatus.tg_username.startsWith('@') ? '' : '@'}${linkStatus.tg_username}`
                          : t('settings.connections.telegramAccount'))
                        : t('settings.connections.telegramDescription')}
                    </div>
                  </div>

                  {linkStatus?.linked ? (
                    <button
                      className={s.connectionDangerBtn}
                      onClick={() => {
                        setUnlinkDataOwner('desktop');
                        setShowTelegramUnlinkModal(true);
                      }}
                      disabled={linkStatus.can_unlink === false}
                    >
                      {t('settings.connections.unlink')}
                    </button>
                  ) : (
                    <button
                      className={s.saveBtn}
                      onClick={() => setShowTelegramLinkModal(true)}
                    >
                      {t('settings.connections.link')}
                    </button>
                  )}
                </div>
              )}

              {linkStatus?.linked && (
                <div className={s.connectionNotice}>
                  {t('settings.connections.unlinkHelp')}
                </div>
              )}
            </div>
          )}

          {section === 'prompt' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.prompt')}</div>

              {promptsLoading ? (
                <div className={s.promptLoading}>{t('common.loading')}</div>
              ) : (
                <>
                  <div className={s.fieldGroup}>
                    <label className={s.fieldLabel}>{t('settings.prompt.style')}</label>
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
                        {selectedPromptId === CUSTOM_PROMPT_ID ? t('settings.prompt.new') : t('settings.prompt.edit')}
                      </label>
                      <input
                        className={s.fieldInput}
                        value={promptName}
                        onChange={(e) => setPromptName(e.target.value.slice(0, 80))}
                        placeholder={t('settings.prompt.namePlaceholder')}
                        maxLength={80}
                      />
                      <input
                        className={s.fieldInput}
                        value={promptDesc}
                        onChange={(e) => setPromptDesc(e.target.value.slice(0, 200))}
                        placeholder={t('settings.prompt.descriptionPlaceholder')}
                        maxLength={200}
                      />
                      <textarea
                        className={s.textareaInput}
                        value={customContent}
                        onChange={(e) => setCustomContent(e.target.value.slice(0, 10000))}
                        placeholder={t('settings.prompt.textPlaceholder')}
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
                            {promptSaving ? t('common.saving') : (selectedPromptId === CUSTOM_PROMPT_ID ? t('common.create') : t('common.save'))}
                          </button>
                          {selectedPromptId !== null && selectedPromptId <= -1000 && (
                            <button
                              className={s.cancelBtn}
                              onClick={handleDeleteCustomPrompt}
                              disabled={promptDeleting}
                              style={{ color: '#e74c3c' }}
                            >
                              {promptDeleting ? t('common.deleting') : t('common.delete')}
                            </button>
                          )}
                        </div>
                        <span style={{ fontSize: '11px', color: customContent.length >= 10000 ? '#e74c3c' : 'var(--text-hint)' }}>
                          {customContent.length} / 10000
                        </span>
                      </div>

                      {/* AI generation */}
                      <div className={s.fieldGroup}>
                        <div className={s.macroFormDivider} />
                        <button
                          onClick={() => {
                            if (!aiPanelOpen) {
                              api.getModels().then(res => setAiPreferredModel(res.preferred_model)).catch(() => {});
                            }
                            setAiPanelOpen(v => !v);
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '6px',
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: aiPanelOpen ? 'var(--accent_icon, var(--accent))' : 'var(--text-muted)',
                            fontSize: '13px', fontWeight: 500, padding: 0,
                            transition: 'color 0.1s',
                          }}
                          type="button"
                        >
                          <span>{t('settings.prompt.ai')}</span>
                          <svg
                            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            style={{ transition: 'transform 0.15s', transform: aiPanelOpen ? 'rotate(180deg)' : 'none' }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        <AnimatePresence initial={false}>
                          {aiPanelOpen && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto', transition: { duration: 0.2, ease: 'easeOut' } }}
                              exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
                              style={{ overflow: 'visible' }}
                            >
                              <div style={{ marginTop: '10px' }}>
                                <span className={s.fieldLabel} style={{ display: 'block', marginBottom: '6px' }}>
                                  {t('settings.prompt.primaryModelHelp')}
                                </span>
                                <textarea
                                  className={s.textareaInput}
                                  value={aiInstruction}
                                  onChange={(e) => setAiInstruction(e.target.value.slice(0, 50000))}
                                  placeholder={t('settings.prompt.aiPlaceholder')}
                                  rows={2}
                                  maxLength={50000}
                                />
                                <div style={{ marginTop: '8px' }}>
                                  <label className={s.fieldLabel} style={{ display: 'block', marginBottom: '4px' }}>
                                    {t('settings.prompt.detail')}
                                  </label>
                                  <Select
                                    options={[
                                      { value: 'minimal', label: t('settings.prompt.detailMinimal') },
                                      { value: 'medium', label: t('settings.prompt.detailMedium') },
                                      { value: 'detailed', label: t('settings.prompt.detailDetailed') },
                                      { value: 'none', label: t('settings.prompt.detailAny') },
                                    ]}
                                    value={aiDetail}
                                    onChange={setAiDetail}
                                  />
                                </div>
                                <button
                                  className={s.saveBtn}
                                  onClick={handleAiGenerate}
                                  disabled={aiGenerating || !aiInstruction.trim()}
                                  style={{ marginTop: '8px' }}
                                  type="button"
                                >
                                  {aiGenerating ? t('settings.prompt.generating') : t('settings.prompt.generate')}
                                </button>

                                {/* Diff preview */}
                                {aiDiff && (
                                  <div className={s.aiDiffWrap}>
                                    <div className={s.aiDiffHeader}>
                                      <span>{t('settings.prompt.preview')}</span>
                                      <div style={{ display: 'flex', gap: '6px' }}>
                                        <button
                                          type="button"
                                          className={s.aiDiffApplyBtn}
                                          onClick={handleAiApply}
                                        >
                                          {t('common.apply')}
                                        </button>
                                        <button
                                          type="button"
                                          className={s.cancelBtn}
                                          onClick={handleAiDismiss}
                                        >
                                          {t('common.cancel')}
                                        </button>
                                      </div>
                                    </div>
                                    <div className={s.aiDiffBody}>
                                      {aiDiff.map((part, i) => (
                                        <div
                                          key={i}
                                          className={`${s.aiDiffLine} ${
                                            part.added ? s.aiDiffAdded :
                                            part.removed ? s.aiDiffRemoved : ''
                                          }`}
                                        >
                                          <span className={s.aiDiffPrefix}>
                                            {part.added ? '+' : part.removed ? '−' : ' '}
                                          </span>
                                          <span className={s.aiDiffText}>{part.value}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {section === 'voice' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.voice')}</div>

              <div className={s.voiceSectionTitle}>{t('settings.voice.recognitionTitle')}</div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.voice.recognitionLanguage')}</label>
                <Select
                  options={recognitionLanguageOptions}
                  value={recognitionLanguage}
                  onChange={handleRecognitionLanguageChange}
                  placeholder={t('settings.voice.recognitionAuto')}
                  searchable
                  maxVisibleItems={6}
                />
                <div className={s.voiceHint}>{t('settings.voice.recognitionHint')}</div>
              </div>

              <div className={s.voiceDivider} />
              <div className={s.voiceSectionTitle}>{t('settings.voice.synthesisTitle')}</div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.voice.model')}</label>
                <Select
                  options={modelOptions}
                  value={ttsSettings.modelId}
                  onChange={handleModelChange}
                  placeholder={t('settings.voice.modelPlaceholder')}
                />
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.sections.voice')}</label>
                <div className={s.voiceRow}>
                  <div className={s.voiceSelect}>
                    {selectedVoiceListLoading ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>{t('settings.voice.loadingVoices')}</div>
                    ) : (
                      <Select
                        options={voiceOptions}
                        value={ttsSettings.voiceId}
                        onChange={handleVoiceChange}
                        placeholder={t('settings.voice.voicePlaceholder')}
                        searchable
                        maxVisibleItems={6}
                      />
                    )}
                  </div>
                  <button
                    className={`${s.previewBtn} ${previewPlaying ? s.previewBtnPlaying : ''}`}
                    onClick={handlePreview}
                    title={t('settings.voice.preview')}
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
                <label className={s.fieldLabel}>{t('settings.voice.speechVolume')}</label>
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
                <label className={s.fieldLabel}>{t('settings.voice.effectsVolume')}</label>
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

          {section === 'mail' && (
            <MailSettings />
          )}

          {section === 'restrictions' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.restrictions')}</div>
              <span className={s.fieldLabel} style={{ display: 'block', marginBottom: 12, marginTop: -4 }}>
                {t('settings.restrictions.help')}
              </span>

              {flagsLoading ? (
                <div className={s.promptLoading}>{t('common.loading')}</div>
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.memoryWrite')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.memoryWriteHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.lite')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.liteHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.noPcCommands')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.noPcCommandsHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.full')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.fullHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.noInternet')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.noInternetHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.guest')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.guestHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.noSpecializedSubagents')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.noSpecializedSubagentsHelp')}
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
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.noAdhocSubagents')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.noAdhocSubagentsHelp')}
                        </div>
                      </div>
                    </label>
                  </div>

                  <div className={s.fieldGroup}>
                    <label className={s.macroToggleLabel}>
                      <input
                        type="checkbox"
                        className={s.macroCheckbox}
                        checked={!wakeWordEnabled}
                        onChange={() => {
                          const next = !wakeWordEnabled;
                          setWakeWordEnabled(next);
                          setWakeWordEnabledStorage(next);
                        }}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.noWakeWord')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.noWakeWordHelp')}
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
              <div className={s.panelTitle}>{t('settings.models.title')}</div>
              <span className={s.fieldLabel} style={{ display: 'block', marginBottom: 12, marginTop: -4 }}>
                {t('settings.models.help')}
              </span>

              {modelsLoading ? (
                <div className={s.promptLoading}>{t('common.loading')}</div>
              ) : modelsCatalog.length === 0 ? (
                <div className={s.fieldLabel}>{t('settings.models.empty')}</div>
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
                          {isSaving && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-hint)' }}>{t('common.savingLower')}</span>}
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
                                  label={t('settings.reasoning.autoLower')}
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

          {section === 'billing' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.billing')}</div>
              <div className={s.promptLoading}>{t('common.inDevelopment')}</div>
            </div>
          )}

          {section === 'app' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.app')}</div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.app.interfaceLanguage')}</label>
                <Select
                  options={languageOptions}
                  value={languagePreference}
                  onChange={handleLanguagePreferenceChange}
                  placeholder={t('settings.language.system')}
                />
              </div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.app.zoom')}</label>
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
                <label className={s.fieldLabel}>{t('settings.app.renderPerf')}</label>
                <Select
                  options={renderPerfOptions}
                  value={renderPerf}
                  onChange={handleRenderPerfChange}
                />
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  {t('settings.app.renderPerfHelp')}
                </div>
              </div>

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={uiSettings.show_tokens !== false}
                  onChange={handleToggleShowTokens}
                  label={t('settings.app.showTokens')}
                  disabled={uiSettingsSaving}
                />
              </div>

              <div className={s.fieldGroup}>
                <div className={chatS.modelSelector}>
                  {modelsCatalog.length > 0 && (
                    <>
                      <label className={chatS.modelLabel}>{t('settings.app.subagentModel')}</label>
                      <div className={chatS.modelSelectWrap}>
                        <Select
                          options={[
                            { value: '', label: t('settings.reasoning.auto'), hint: t('settings.app.automaticSelection') },
                            ...modelsCatalog.map(m => ({
                              value: m.id,
                              label: m.name,
                              hint: m.description || undefined,
                            })),
                          ]}
                          value={subagentModel || ''}
                          onChange={handleSubagentModelChange}
                          placeholder={t('settings.reasoning.auto')}
                          disabled={subagentModelSaving}
                        />
                      </div>
                    </>
                  )}
                  {subagentAvailableReasoningLevels.length > 1 && (
                    <div className={chatS.reasoningControl}>
                      <Slider
                        mode="discrete"
                        label={t('settings.app.reasoning')}
                        values={subagentAvailableReasoningLevels}
                        labels={reasoningLevelLabels}
                        value={subagentReasoningLevel}
                        onChange={(v) => setSubagentReasoningLevelState(v as api.ReasoningLevel | null)}
                        onCommit={handleSubagentReasoningCommit}
                        disabled={subagentReasoningSaving}
                      />
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  {t('settings.app.subagentHelp')}
                </div>
              </div>

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={Boolean(uiSettings.dice_roll_enabled)}
                  onChange={handleToggleDiceRoll}
                  label={t('settings.app.diceMode')}
                  disabled={uiSettingsSaving}
                />
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  {t('settings.app.diceHelp')}
                </div>
              </div>
            </div>
          )}

          {section === 'limits' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.limits')}</div>

              {/* Context Token Limit */}
              {contextTokenLimit && (
                <div className={s.fieldGroup}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    {t('settings.app.contextLimit')}
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
                    {t('settings.app.contextLimitHelp', { max: (contextTokenLimit.max_context_tokens_limit / 1000).toFixed(0) })}
                  </div>
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
                    {t('settings.app.attachmentLimit')}
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
                      formatValue={(v) => v === 0 ? t('settings.reasoning.auto') : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
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
                    {t('settings.app.attachmentLimitHelp', { max: (attachmentTokenLimit.attachment_max_tokens_limit / 1000).toFixed(0) })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>

      <AnimatePresence>
        {showTelegramLinkModal && (
          <LinkTelegramModal
            key="settings-telegram-link"
            onClose={() => setShowTelegramLinkModal(false)}
            onLinked={handleTelegramLinked}
          />
        )}

        {showTelegramUnlinkModal && (
          <motion.div
            key="settings-telegram-unlink"
            className={s.accountSplitOverlay}
            onClick={() => {
              if (!unlinkingTelegram) setShowTelegramUnlinkModal(false);
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className={s.accountSplitModal}
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
            >
              <div className={s.accountSplitHeader}>
                <img className={s.accountSplitIcon} src={telegramIcon} alt="" />
                <div>
                  <div className={s.accountSplitTitle}>{t('settings.connections.unlinkTitle')}</div>
                  <div className={s.accountSplitText}>{t('settings.connections.unlinkQuestion')}</div>
                </div>
              </div>

              <div className={s.accountOwnerChoices}>
                <button
                  className={`${s.accountOwnerChoice} ${unlinkDataOwner === 'desktop' ? s.accountOwnerChoiceActive : ''}`}
                  onClick={() => setUnlinkDataOwner('desktop')}
                  disabled={unlinkingTelegram}
                >
                  <span className={s.accountOwnerRadio} />
                  <span>
                    <strong>{t('settings.connections.keepDesktop')}</strong>
                    <small>{t('settings.connections.keepDesktopHelp')}</small>
                  </span>
                </button>
                <button
                  className={`${s.accountOwnerChoice} ${unlinkDataOwner === 'telegram' ? s.accountOwnerChoiceActive : ''}`}
                  onClick={() => setUnlinkDataOwner('telegram')}
                  disabled={unlinkingTelegram}
                >
                  <span className={s.accountOwnerRadio} />
                  <span>
                    <strong>{t('settings.connections.keepTelegram')}</strong>
                    <small>{t('settings.connections.keepTelegramHelp')}</small>
                  </span>
                </button>
              </div>

              <div className={s.accountSplitWarning}>
                {t('settings.connections.unlinkWarning')}
              </div>

              <div className={s.accountSplitActions}>
                <button
                  className={s.cancelBtn}
                  onClick={() => setShowTelegramUnlinkModal(false)}
                  disabled={unlinkingTelegram}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className={s.connectionDangerBtn}
                  onClick={handleTelegramUnlink}
                  disabled={unlinkingTelegram}
                >
                  {unlinkingTelegram
                    ? t('settings.connections.unlinking')
                    : t('settings.connections.unlink')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
