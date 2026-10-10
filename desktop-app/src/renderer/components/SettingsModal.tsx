import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { diffLines } from 'diff';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { PromptSelector } from './PromptSelector';
import { getTtsModels, getTtsSettings, setTtsSettings, ttsPreview, ttsStopPreview, getVoicesForModel, fetchRemoteTtsProviders, fetchPiperVoiceList } from '../lib/tts';
import type { TtsSettings } from '../lib/tts';
import {
  getSpeechRecognitionLanguage,
  getSpeechRecognitionSource,
  setSpeechRecognitionLanguage,
  setSpeechRecognitionSource,
  type SpeechRecognitionLanguage,
  type SpeechRecognitionSource,
} from '../lib/speechRecognition';
import { getWakeWordEnabled, setWakeWordEnabled as setWakeWordEnabledStorage } from '../lib/wakeWordToggle';
import { getRenderPerfLevel, setRenderPerfLevel, type RenderPerfLevel } from '../lib/renderPerf';
import { getThemePreference, setThemePreference, type ThemePreference } from '../lib/theme';
import { parsePromptSections, serializePromptSections, type PromptSectionKey, type PromptSections } from '../lib/promptSections';
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
import { Tooltip } from './Tooltip';
import { MacroSettings } from './MacroSettings';
import { ServerSettings } from './ServerSettings';
import { RunbookSettings } from './RunbookSettings';
import { SshKeySettings } from './SshKeySettings';
import { SmartHomeSettings } from './SmartHomeSettings';
import { MailSettings } from './MailSettings';
import { PCSettings } from './PCSettings';
import { BrowserSettings } from './BrowserSettings';
import { LinkTelegramModal } from './LinkTelegramModal';
import { QuotaWidget } from './QuotaWidget';
import { SubagentModelSettings } from './SubagentModelSettings/SubagentModelSettings';
import { AboutSettings } from './AboutSettings/AboutSettings';
import { GlobalMemorySettings } from './GlobalMemorySettings';
import { ChatGptSettings } from './ChatGptSettings';
import { PromptImageCropDialog } from './PromptImageCropDialog';
import { CharacterCardImportDialog } from './CharacterCardImportDialog';
import { PersonaImportDialog } from './PersonaImportDialog';
import { SillyTavernChatImportDialog } from './SillyTavernChatImportDialog';
import { SillyTavernBackupImportDialog } from './SillyTavernBackupImportDialog';
import telegramIcon from '../assets/integrations/telegram.webp';
import s from './SettingsModal.module.scss';

type Props = {
  onClose: () => void;
  onAccountChanged?: () => void | Promise<void>;
  onChatCreated?: (chatId: number) => void | Promise<void>;
  /** Called when the user changed their password or login and server tokens
   *  were revoked — the parent must force a sign-out and close the modal. */
  onAuthInvalidated?: () => void;
};

type Section = 'account' | 'memory' | 'connections' | 'prompt' | 'data' | 'voice' | 'app' | 'admin' | 'limits' | 'billing' | 'macros' | 'pc' | 'browser' | 'servers' | 'runbooks' | 'sshkeys' | 'mail' | 'smart_home' | 'restrictions' | 'models' | 'about';

const CUSTOM_PROMPT_ID = -1;
const NEW_PERSONA_ID = -1;

type PersonaInfo = {
  id: number;
  name: string;
  description: string;
  core_memory: string;
  image_url: string | null;
  allow_core_memory_update: number;
  is_primary: number;
  is_default: number;
};

const ZOOM_STEP_PCT = 5;
const ZOOM_MIN_PCT = 40;
const ZOOM_MAX_PCT = 200;

const COMMON_TIMEZONE_OFFSETS = [
  -12, -11, -10, -9.5, -9, -8, -7, -6, -5, -4, -3.5, -3, -2, -1,
  0, 1, 2, 3, 3.5, 4, 4.5, 5, 5.5, 5.75, 6, 6.5, 7, 8, 8.75,
  9, 9.5, 10, 10.5, 11, 12, 12.75, 13, 13.75, 14,
];

const normalizeTimezoneOffset = (offset: number) => Math.min(14, Math.max(-12, Math.round(offset * 4) / 4));

const formatTimezoneOffset = (offset: number) => {
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute);
  const minutes = Math.round((absolute - hours) * 60);
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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

const SECTIONS: { key: Section; labelKey: string }[] = [
  { key: 'account', labelKey: 'settings.sections.account' },
  { key: 'memory', labelKey: 'settings.sections.memory' },
  { key: 'connections', labelKey: 'settings.sections.connections' },
  { key: 'prompt', labelKey: 'settings.sections.prompt' },
  { key: 'data', labelKey: 'settings.sections.data' },
  { key: 'voice', labelKey: 'settings.sections.voice' },
  { key: 'macros', labelKey: 'settings.sections.macros' },
  { key: 'pc', labelKey: 'settings.sections.pc' },
  { key: 'browser', labelKey: 'settings.sections.browser' },
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
  { key: 'admin', labelKey: 'settings.sections.admin' },
  { key: 'about', labelKey: 'settings.sections.about' },
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

export function SettingsModal({ onClose, onAccountChanged, onChatCreated, onAuthInvalidated }: Props) {
  const { user, setUser } = useAuth();
  const isAdmin = user?.is_admin === 1 || user?.role === 'admin';
  const { t, i18n } = useTranslation();
  const [section, setSection] = useState<Section>('account');

  // Account
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);
  const detectedTimezoneOffset = useMemo(
    () => normalizeTimezoneOffset(-new Date().getTimezoneOffset() / 60),
    [],
  );
  const [timezoneValue, setTimezoneValue] = useState('');
  const [timezoneSaving, setTimezoneSaving] = useState(false);
  const timezoneOptions = useMemo<SelectOption[]>(() => {
    const offsets = COMMON_TIMEZONE_OFFSETS.includes(detectedTimezoneOffset)
      ? COMMON_TIMEZONE_OFFSETS
      : [...COMMON_TIMEZONE_OFFSETS, detectedTimezoneOffset].sort((a, b) => a - b);
    return offsets.map(offset => ({
      value: String(offset),
      label: formatTimezoneOffset(offset),
      hint: offset === detectedTimezoneOffset ? t('settings.account.timezoneDevice') : undefined,
    }));
  }, [detectedTimezoneOffset, t]);
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
  const [promptEditorMode, setPromptEditorMode] = useState<'usual' | 'advanced'>('usual');
  const [promptSections, setPromptSections] = useState<PromptSections>(() => parsePromptSections(''));
  const [promptImageUrl, setPromptImageUrl] = useState<string | null>(null);
  const [pendingPromptImage, setPendingPromptImage] = useState<{ base64: string; mimeType: string; previewUrl: string } | null>(null);
  const [promptImageCropSource, setPromptImageCropSource] = useState<string | null>(null);
  const [promptImageRemoved, setPromptImageRemoved] = useState(false);
  const promptImageInputRef = useRef<HTMLInputElement>(null);
  /** Plan-derived custom prompt limit; 20000 fallback until the server responds. */
  const [maxPromptLength, setMaxPromptLength] = useState(20000);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptDeleting, setPromptDeleting] = useState(false);
  const [characterCardReading, setCharacterCardReading] = useState(false);
  const [characterCardImporting, setCharacterCardImporting] = useState(false);
  const [characterChatStarting, setCharacterChatStarting] = useState(false);
  const [characterCardDialog, setCharacterCardDialog] = useState<{
    file: api.CharacterCardFile;
    preview: api.CharacterCardPreview;
    imageUrl: string | null;
  } | null>(null);
  const characterCardInputRef = useRef<HTMLInputElement>(null);
  const [lastImportedPrompt, setLastImportedPrompt] = useState<{ id: number; name: string } | null>(null);

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
  const [piperLoading, setPiperLoading] = useState(false);
  const [piperVoicesReady, setPiperVoicesReady] = useState(false);
  const [remoteProvidersReady, setRemoteProvidersReady] = useState(false);
  const [recognitionLanguage, setRecognitionLanguage] = useState<SpeechRecognitionLanguage>(
    () => getSpeechRecognitionLanguage(),
  );
  const [recognitionSource, setRecognitionSourceState] = useState<SpeechRecognitionSource>(
    () => getSpeechRecognitionSource(),
  );
  const [wakeWordEnabled, setWakeWordEnabled] = useState(() => getWakeWordEnabled());

  const recognitionLanguageOptions = useMemo<SelectOption[]>(() => [
    { value: 'auto', label: t('settings.voice.recognitionAuto') },
    ...SUPPORTED_LANGUAGES.map((language) => ({ value: language, label: getLanguageDisplayName(language) })),
  ], [i18n.language, t]);

  const transcriptionStatusQuery = useQuery({
    queryKey: ['transcription', 'status'],
    queryFn: api.fetchTranscriptionStatus,
    enabled: section === 'voice',
    staleTime: 30_000,
  });

  const recognitionSourceOptions = useMemo<SelectOption[]>(() => [
    {
      value: 'local',
      label: t('settings.voice.recognitionSourceLocal'),
      hint: t('settings.voice.recognitionSourceLocalHint'),
    },
    {
      value: 'server',
      label: t('settings.voice.recognitionSourceServer'),
      hint: transcriptionStatusQuery.data?.available
        ? t('settings.voice.recognitionSourceServerReady', { model: transcriptionStatusQuery.data.model })
        : t('settings.voice.recognitionSourceServerUnavailable'),
      disabled: !transcriptionStatusQuery.data?.available,
    },
  ], [transcriptionStatusQuery.data, t]);

  const remoteProvidersQuery = useQuery({
    queryKey: ['tts', 'remote-providers'],
    queryFn: () => fetchRemoteTtsProviders(true),
    enabled: section === 'voice',
    staleTime: 10 * 60 * 1000,
    gcTime: Infinity,
  });

  const syncAvailableTtsModels = useCallback(() => {
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
  }, []);

  // Refresh local Piper voices when voice settings open.
  useEffect(() => {
    if (section !== 'voice') return;

    let cancelled = false;
    setTtsModels(getTtsModels());
    setPiperLoading(true);

    void fetchPiperVoiceList()
      .then(() => {
        if (cancelled) return;
        setTtsModels(getTtsModels());
        setPiperVoicesReady(true);
      })
      .finally(() => { if (!cancelled) setPiperLoading(false); });

    return () => {
      cancelled = true;
    };
  }, [section, syncAvailableTtsModels]);

  useEffect(() => {
    if (section !== 'voice' || !remoteProvidersQuery.data) return;
    setTtsModels(getTtsModels());
    setRemoteProvidersReady(true);
  }, [remoteProvidersQuery.data, section]);

  useEffect(() => {
    if (section !== 'voice' || !piperVoicesReady || !remoteProvidersReady) return;
    syncAvailableTtsModels();
  }, [
    piperVoicesReady,
    remoteProvidersReady,
    section,
    syncAvailableTtsModels,
  ]);

  const [coreMemory, setCoreMemory] = useState('');
  const [coreMemorySaving, setCoreMemorySaving] = useState(false);
  const [selectedPersonaId, setSelectedPersonaId] = useState<number | null>(null);
  const [personaName, setPersonaName] = useState('');
  const [personaDescription, setPersonaDescription] = useState('');
  const [allowCoreMemoryUpdate, setAllowCoreMemoryUpdate] = useState(true);
  const [personaDeleting, setPersonaDeleting] = useState(false);
  const [personaImageUrl, setPersonaImageUrl] = useState<string | null>(null);
  const [pendingPersonaImage, setPendingPersonaImage] = useState<{ base64: string; mimeType: string; previewUrl: string } | null>(null);
  const [personaImageCropSource, setPersonaImageCropSource] = useState<string | null>(null);
  const [personaImageRemoved, setPersonaImageRemoved] = useState(false);
  const personaImageInputRef = useRef<HTMLInputElement>(null);
  const personaImportInputRef = useRef<HTMLInputElement>(null);
  const [personaImportReading, setPersonaImportReading] = useState(false);
  const [personaImporting, setPersonaImporting] = useState(false);
  const [personaImportDialog, setPersonaImportDialog] = useState<{ file: api.CharacterCardFile; preview: api.PersonaImportPreview } | null>(null);
  const [lastPersonaImport, setLastPersonaImport] = useState<{ created: number; updated: number; activePersonaId: number | null } | null>(null);
  const sillyTavernBackupInputRef = useRef<HTMLInputElement>(null);
  const [sillyTavernBackupReading, setSillyTavernBackupReading] = useState(false);
  const [sillyTavernBackupImporting, setSillyTavernBackupImporting] = useState(false);
  const [sillyTavernBackupDialog, setSillyTavernBackupDialog] = useState<{
    importId: string;
    preview: api.SillyTavernBackupPreview;
  } | null>(null);
  const [backupImportProgress, setBackupImportProgress] = useState<api.BackupImportProgress | null>(null);
  const [lastBackupImport, setLastBackupImport] = useState<api.SillyTavernBackupImportResult | null>(null);
  const sillyTavernChatInputRef = useRef<HTMLInputElement>(null);
  const [sillyTavernChatsReading, setSillyTavernChatsReading] = useState(false);
  const [sillyTavernChatsImporting, setSillyTavernChatsImporting] = useState(false);
  const [sillyTavernChatDialog, setSillyTavernChatDialog] = useState<{ files: api.SillyTavernChatFile[]; previews: api.SillyTavernChatPreview[] } | null>(null);
  const [lastChatImport, setLastChatImport] = useState<Array<{ file_name: string; chat_id: number; status: 'created' | 'existing'; message_count: number }> | null>(null);
  const personaDraftSourceRef = useRef<number | null>(null);
  const personasQuery = useQuery({
    queryKey: ['memory-personas'],
    queryFn: () => api.apiFetch<{ personas: PersonaInfo[] }>('/api/v1/memory/personas'),
    enabled: section === 'account',
    staleTime: 30_000,
  });
  const personas = personasQuery.data?.personas ?? [];

  // Feature flags (restrictions)
  const [featureFlags, setFeatureFlagsState] = useState<api.FeatureFlags>({
    disable_prompt_injection_protection: false,
    disable_memory_write: false,
    disable_pc_control_lite: false,
    disable_pc_control_full: false,
    disable_pc_commands: false,
    disable_internet: false,
    disable_personal: false,
    disable_specialized_subagents: false,
    disable_adhoc_subagents: false,
    disable_avatar_control: false,
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
  const [desktopBrowserSettings, setDesktopBrowserSettingsState] = useState({ concurrency: 2, searchEnabled: true, readerEnabled: true });
  const [desktopBrowserSettingsSaving, setDesktopBrowserSettingsSaving] = useState(false);
  const [languagePreference, setLanguagePreferenceState] = useState<LanguagePreference>(
    () => getLanguagePreference(),
  );
  const [renderPerf, setRenderPerfState] = useState<RenderPerfLevel>(() => getRenderPerfLevel());
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => getThemePreference());
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
  const savedContextTokenLimitRef = useRef<number | null>(null);
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
      const savedOffset = Number(user.timezone_offset);
      setTimezoneValue(String(
        user.timezone_confirmed && Number.isFinite(savedOffset)
          ? normalizeTimezoneOffset(savedOffset)
          : detectedTimezoneOffset,
      ));
    }
  }, [user, detectedTimezoneOffset]);

  // Refresh core memory from server when account tab opens
  useEffect(() => {
    if (section === 'account') {
      api.apiFetch('/api/v1/auth/me')
        .then((res: any) => {
          if (user) {
            const updated = { ...user, ...res.user, core_memory: res.user.core_memory || '' };
            setUser(updated);
            localStorage.setItem('chatter_user', JSON.stringify(updated));
          }
        })
        .catch(() => {});
    }
  }, [section]);

  const loadPersonas = useCallback(async (preferredId?: number) => {
    const refreshed = await personasQuery.refetch();
    const result = refreshed.data ?? { personas: [] };
    const selected = preferredId !== undefined
      ? result.personas.find(persona => persona.id === preferredId)
      : result.personas.find(persona => persona.is_default === 1);
    const persona = selected || result.personas[0];
    if (persona) {
      personaDraftSourceRef.current = null;
      setSelectedPersonaId(persona.id);
    }
  }, [personasQuery.refetch]);

  useEffect(() => {
    if (section !== 'account' || !personas.length) return;
    if (selectedPersonaId === NEW_PERSONA_ID) return;
    if (selectedPersonaId === null || !personas.some(persona => persona.id === selectedPersonaId)) {
      const persona = personas.find(item => item.is_default === 1) || personas[0];
      personaDraftSourceRef.current = null;
      setSelectedPersonaId(persona.id);
    }
  }, [section, personas, selectedPersonaId]);

  useEffect(() => {
    if (selectedPersonaId === NEW_PERSONA_ID) {
      if (personaDraftSourceRef.current === NEW_PERSONA_ID) return;
      personaDraftSourceRef.current = NEW_PERSONA_ID;
      setPersonaName('');
      setPersonaDescription('');
      setCoreMemory('');
      setAllowCoreMemoryUpdate(true);
      setPersonaImageUrl(null);
      setPendingPersonaImage(null);
      setPersonaImageRemoved(false);
      return;
    }
    const persona = personas.find(item => item.id === selectedPersonaId);
    if (!persona) return;
    if (personaDraftSourceRef.current === persona.id) return;
    personaDraftSourceRef.current = persona.id;
    setPersonaName(persona.name);
    setPersonaDescription(persona.description || '');
    setCoreMemory(persona.core_memory || '');
    setAllowCoreMemoryUpdate(persona.allow_core_memory_update === 1);
    setPersonaImageUrl(persona.image_url || null);
    setPendingPersonaImage(null);
    setPersonaImageRemoved(false);
  }, [selectedPersonaId, personas]);

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
      window.electronAPI.getDesktopBrowserSettings()
        .then(setDesktopBrowserSettingsState)
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
        .then((res) => {
          setContextTokenLimitState(res);
          savedContextTokenLimitRef.current = res.max_context_tokens;
        })
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

  const themeOptions = useMemo<SelectOption[]>(() => [
    { value: 'system', label: t('settings.app.themeSystem') },
    { value: 'light', label: t('settings.app.themeLight') },
    { value: 'dark', label: t('settings.app.themeDark') },
  ], [t]);

  const handleThemeChange = (value: string) => {
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    setThemePreferenceState(value);
    setThemePreference(value);
  };

  const handleRenderPerfChange = (value: string) => {
    if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'ultra') return;
    setRenderPerfState(value as RenderPerfLevel);
    setRenderPerfLevel(value as RenderPerfLevel);
    toast.success(t('settings.app.renderPerfSaved'));
  };

  const desktopBrowserConcurrencyOptions = useMemo<SelectOption[]>(() => [1, 2, 3, 4, 5, 6].map(value => ({
    value: String(value),
    label: String(value),
  })), []);

  const saveDesktopBrowserSettings = async (next: typeof desktopBrowserSettings) => {
    const previous = desktopBrowserSettings;
    setDesktopBrowserSettingsState(next);
    setDesktopBrowserSettingsSaving(true);
    try {
      setDesktopBrowserSettingsState(await window.electronAPI.setDesktopBrowserSettings(next));
    } catch {
      setDesktopBrowserSettingsState(previous);
      toast.error(t('settings.toasts.saveSettingFailed'));
    } finally {
      setDesktopBrowserSettingsSaving(false);
    }
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
      if (savedContextTokenLimitRef.current !== null && res.max_context_tokens < savedContextTokenLimitRef.current) {
        toast.info(t('settings.toasts.contextLimitReduced'));
      }
      savedContextTokenLimitRef.current = res.max_context_tokens;
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
        if (Number.isFinite(res.max_custom_prompt_length) && (res.max_custom_prompt_length as number) >= 0) {
          setMaxPromptLength(res.max_custom_prompt_length as number);
        }
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
        setPromptSections(parsePromptSections(cp.content));
        setPromptImageUrl(cp.image_url);
        setPendingPromptImage(null);
        setPromptImageRemoved(false);
      }
    } else if (selectedPromptId === CUSTOM_PROMPT_ID) {
      // New prompt: blank fields
      setPromptName('');
      setPromptDesc('');
      setCustomContent('');
      setPromptSections(parsePromptSections(''));
      setPromptImageUrl(null);
      setPendingPromptImage(null);
      setPromptImageRemoved(false);
    }
  }, [selectedPromptId, customPrompts]);

  const handleSaveName = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.setUserName(trimmed);
      await loadPersonas(selectedPersonaId ?? undefined);
      window.dispatchEvent(new Event('chatter:personas-changed'));
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

  const handleSaveTimezone = async () => {
    const timezoneOffset = Number(timezoneValue);
    if (!Number.isFinite(timezoneOffset)) return;
    setTimezoneSaving(true);
    try {
      const result = await api.setUserTimezone(timezoneOffset);
      const updated = {
        ...user!,
        timezone_offset: result.timezone_offset,
        timezone_confirmed: result.timezone_confirmed,
      };
      setUser(updated);
      localStorage.setItem('chatter_user', JSON.stringify(updated));
      toast.success(t('settings.toasts.timezoneSaved'));
    } catch {
      toast.error(t('settings.toasts.timezoneSaveFailed'));
    } finally {
      setTimezoneSaving(false);
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

  const handleSelectPersona = async (personaId: number) => {
    personaDraftSourceRef.current = null;
    setSelectedPersonaId(personaId);
    if (personaId === NEW_PERSONA_ID) return;
    try {
      await api.apiFetch(`/api/v1/memory/personas/${personaId}/activate`, { method: 'POST' });
      await personasQuery.refetch();
      window.dispatchEvent(new Event('chatter:personas-changed'));
      const persona = personas.find(item => item.id === personaId);
      if (persona?.is_primary === 1 && user) {
        const updated = { ...user, core_memory: persona.core_memory };
        setUser(updated);
        localStorage.setItem('chatter_user', JSON.stringify(updated));
      }
    } catch {
      toast.error(t('settings.account.personas.errors.select'));
    }
  };

  const handleSaveCoreMemory = async () => {
    const selectedPersona = personas.find(persona => persona.id === selectedPersonaId);
    const isPrimary = selectedPersona?.is_primary === 1;
    const name = personaName.trim();
    if (!isPrimary && !name) {
      toast.error(t('settings.account.personas.errors.nameRequired'));
      return;
    }
    setCoreMemorySaving(true);
    try {
      const attemptedPersonaImage = pendingPersonaImage;
      const attemptedPersonaImageRemoval = personaImageRemoved;
      let personaId = selectedPersonaId;
      if (personaId === NEW_PERSONA_ID || personaId === null) {
        const created = await api.apiFetch<{ persona: PersonaInfo }>('/api/v1/memory/personas', {
          method: 'POST',
          body: JSON.stringify({ name, description: personaDescription.trim(), core_memory: coreMemory, allow_core_memory_update: allowCoreMemoryUpdate }),
        });
        personaId = created.persona.id;
      } else {
        await api.apiFetch(`/api/v1/memory/personas/${personaId}`, {
          method: 'PATCH',
          body: JSON.stringify(isPrimary
            ? { core_memory: coreMemory, allow_core_memory_update: allowCoreMemoryUpdate }
            : { name, description: personaDescription.trim(), core_memory: coreMemory, allow_core_memory_update: allowCoreMemoryUpdate }),
        });
      }
      let imageSaveFailed = false;
      try {
        if (pendingPersonaImage) {
          const result = await api.setPersonaImage(personaId, { base64: pendingPersonaImage.base64, mime_type: pendingPersonaImage.mimeType });
          setPersonaImageUrl(result.image_url);
        } else if (personaImageRemoved) {
          await api.deletePersonaImage(personaId);
          setPersonaImageUrl(null);
        }
      } catch {
        imageSaveFailed = true;
      }
      await api.apiFetch(`/api/v1/memory/personas/${personaId}/activate`, { method: 'POST' });
      await loadPersonas(personaId);
      personaDraftSourceRef.current = personaId;
      window.dispatchEvent(new Event('chatter:personas-changed'));
      if (isPrimary) {
        const updated = { ...user!, core_memory: coreMemory };
        setUser(updated);
        localStorage.setItem('chatter_user', JSON.stringify(updated));
      }
      toast.success(t('settings.toasts.memorySaved'));
      if (imageSaveFailed) toast.error(t('settings.account.personas.imageSaveError'));
      else {
        setPendingPersonaImage(null);
        setPersonaImageRemoved(false);
      }
      if (imageSaveFailed) {
        setPendingPersonaImage(attemptedPersonaImage);
        setPersonaImageRemoved(attemptedPersonaImageRemoval);
      }
    } catch {
      toast.error(t('settings.toasts.memorySaveFailed'));
    } finally {
      setCoreMemorySaving(false);
    }
  };

  const handlePersonaImageSelect = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error(t('settings.prompt.imageFormatError'));
    if (file.size > 10 * 1024 * 1024) return toast.error(t('settings.prompt.imageSizeError'));
    const reader = new FileReader();
    reader.onerror = () => toast.error(t('settings.prompt.imageReadError'));
    reader.onload = () => {
      const previewUrl = String(reader.result || '');
      if (!previewUrl.includes(',')) return toast.error(t('settings.prompt.imageReadError'));
      setPersonaImageCropSource(previewUrl);
      if (personaImageInputRef.current) personaImageInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  const handlePersonaImportSelect = (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) return toast.error(t('settings.account.personas.import.errors.format'));
    if (file.size > 2 * 1024 * 1024) return toast.error(t('settings.account.personas.import.errors.size'));
    setPersonaImportReading(true);
    const reader = new FileReader();
    reader.onerror = () => { setPersonaImportReading(false); toast.error(t('settings.account.personas.import.errors.read')); };
    reader.onload = async () => {
      try {
        const base64 = String(reader.result || '').split(',', 2)[1] || '';
        const payload = { file_name: file.name, mime_type: file.type || 'application/json', base64 };
        const { preview } = await api.previewSillyTavernPersonas(payload);
        setPersonaImportDialog({ file: payload, preview });
      } catch {
        toast.error(t('settings.account.personas.import.errors.invalid'));
      } finally {
        setPersonaImportReading(false);
        if (personaImportInputRef.current) personaImportInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  const handlePersonaImport = async () => {
    if (!personaImportDialog) return;
    setPersonaImporting(true);
    try {
      const result = await api.importSillyTavernPersonas(personaImportDialog.file);
      await loadPersonas(result.active_persona_id ?? undefined);
      window.dispatchEvent(new Event('chatter:personas-changed'));
      setLastPersonaImport({ created: result.created, updated: result.updated, activePersonaId: result.active_persona_id });
      setPersonaImportDialog(null);
      toast.success(t('settings.account.personas.import.success', { created: result.created, updated: result.updated }));
    } catch {
      toast.error(t('settings.account.personas.import.errors.import'));
    } finally {
      setPersonaImporting(false);
    }
  };

  const handleSillyTavernBackupSelect = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast.error(t('settings.data.backup.errors.format'));
      return;
    }
    if (file.size > 256 * 1024 * 1024) {
      toast.error(t('settings.data.backup.errors.size'));
      return;
    }
    setSillyTavernBackupReading(true);
    try {
      const { preview, import_id } = await api.previewSillyTavernBackup(file);
      setBackupImportProgress(null);
      setSillyTavernBackupDialog({ importId: import_id, preview });
    } catch (error) {
      toast.error(t(error instanceof api.ApiError && error.status === 507 ? 'settings.data.backup.insufficientSpace' : 'settings.data.backup.errors.invalid'));
    } finally {
      setSillyTavernBackupReading(false);
      if (sillyTavernBackupInputRef.current) sillyTavernBackupInputRef.current.value = '';
    }
  };

  const handleSillyTavernBackupImport = async () => {
    if (!sillyTavernBackupDialog) return;
    setSillyTavernBackupImporting(true);
    try {
      const { result } = await api.importSillyTavernBackup(sillyTavernBackupDialog.importId, setBackupImportProgress);
      setLastBackupImport(result);
      setSillyTavernBackupDialog(null);
      await loadPersonas();
      const promptData = await api.getPrompts();
      setPrompts(promptData.prompts);
      setCustomPrompts(promptData.custom_prompts || []);
      setSelectedPromptId(promptData.selected_prompt_id ?? promptData.prompts.find(prompt => prompt.is_default === 1)?.id ?? null);
      window.dispatchEvent(new Event('chatter:personas-changed'));
      await onAccountChanged?.();
      toast.success(t('settings.data.backup.success', {
        characters: result.characters.created,
        personas: result.personas.created + result.personas.updated,
        chats: result.chats.created + result.groups.created,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === 'sillytavern_backup_import_cancelled') {
        setSillyTavernBackupDialog(null);
        await loadPersonas();
        const promptData = await api.getPrompts();
        setPrompts(promptData.prompts);
        setCustomPrompts(promptData.custom_prompts || []);
        window.dispatchEvent(new Event('chatter:personas-changed'));
        await onAccountChanged?.();
        toast.info(t('settings.data.backup.cancelled'));
        return;
      }
      toast.error(t(error instanceof api.ApiError && error.status === 507 ? 'settings.data.backup.insufficientSpace' : 'settings.data.backup.errors.import'));
    } finally {
      setSillyTavernBackupImporting(false);
    }
  };

  const handleSillyTavernChatSelect = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (files.length > 20) {
      toast.error(t('settings.data.chats.errors.count'));
      return;
    }
    if (files.some(file => !file.name.toLowerCase().endsWith('.jsonl'))) {
      toast.error(t('settings.data.chats.errors.format'));
      return;
    }
    if (files.some(file => file.size > 16 * 1024 * 1024)) {
      toast.error(t('settings.data.chats.errors.size'));
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) {
      toast.error(t('settings.data.chats.errors.totalSize'));
      return;
    }
    setSillyTavernChatsReading(true);
    try {
      const payload = await Promise.all(files.map(file => new Promise<api.SillyTavernChatFile>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read_failed'));
        reader.onload = () => resolve({ file_name: file.name, base64: String(reader.result || '').split(',', 2)[1] || '' });
        reader.readAsDataURL(file);
      })));
      const { previews } = await api.previewSillyTavernChats(payload);
      setSillyTavernChatDialog({ files: payload, previews });
    } catch {
      toast.error(t('settings.data.chats.errors.invalid'));
    } finally {
      setSillyTavernChatsReading(false);
      if (sillyTavernChatInputRef.current) sillyTavernChatInputRef.current.value = '';
    }
  };

  const handleSillyTavernChatImport = async () => {
    if (!sillyTavernChatDialog) return;
    setSillyTavernChatsImporting(true);
    try {
      const { results } = await api.importSillyTavernChats(sillyTavernChatDialog.files);
      setLastChatImport(results);
      setSillyTavernChatDialog(null);
      await onAccountChanged?.();
      const created = results.filter(result => result.status === 'created').length;
      const existing = results.length - created;
      toast.success(t('settings.data.chats.success', { created, existing }));
    } catch {
      toast.error(t('settings.data.chats.errors.import'));
    } finally {
      setSillyTavernChatsImporting(false);
    }
  };

  const handleDeletePersona = async () => {
    if (selectedPersonaId === null || selectedPersonaId === NEW_PERSONA_ID) return;
    setPersonaDeleting(true);
    try {
      await api.apiFetch(`/api/v1/memory/personas/${selectedPersonaId}`, { method: 'DELETE' });
      await loadPersonas();
      window.dispatchEvent(new Event('chatter:personas-changed'));
      toast.success(t('settings.account.personas.deleted'));
    } catch {
      toast.error(t('settings.account.personas.errors.delete'));
    } finally {
      setPersonaDeleting(false);
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

  const handlePromptEditorModeChange = (mode: 'usual' | 'advanced') => {
    if (mode === 'advanced') setPromptSections(parsePromptSections(customContent));
    setPromptEditorMode(mode);
  };

  const handlePromptSectionChange = (key: PromptSectionKey, value: string) => {
    let next = { ...promptSections, [key]: value };
    let serialized = serializePromptSections(next);
    if (serialized.length > maxPromptLength) {
      const overflow = serialized.length - maxPromptLength;
      next = { ...next, [key]: value.slice(0, Math.max(0, value.length - overflow)) };
      serialized = serializePromptSections(next);
    }
    setPromptSections(next);
    setCustomContent(serialized);
  };

  const handlePromptImageSelect = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('settings.prompt.imageFormatError'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('settings.prompt.imageSizeError'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error(t('settings.prompt.imageReadError'));
    reader.onload = () => {
      const previewUrl = String(reader.result || '');
      if (!previewUrl.includes(',')) {
        toast.error(t('settings.prompt.imageReadError'));
        return;
      }
      setPromptImageCropSource(previewUrl);
      if (promptImageInputRef.current) promptImageInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  const handlePromptImageRemove = () => {
    setPendingPromptImage(null);
    setPromptImageUrl(null);
    setPromptImageRemoved(true);
    if (promptImageInputRef.current) promptImageInputRef.current.value = '';
  };

  const handleCharacterCardSelect = (file: File | undefined) => {
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.json') && !lowerName.endsWith('.png')) {
      toast.error(t('settings.prompt.characterCard.errors.format'));
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error(t('settings.prompt.characterCard.errors.size'));
      return;
    }
    setCharacterCardReading(true);
    const reader = new FileReader();
    reader.onerror = () => {
      setCharacterCardReading(false);
      toast.error(t('settings.prompt.characterCard.errors.read'));
    };
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.split(',', 2)[1] || '';
        const payload = { file_name: file.name, mime_type: file.type, base64 };
        const { preview } = await api.previewCharacterCard(payload);
        setCharacterCardDialog({ file: payload, preview, imageUrl: lowerName.endsWith('.png') ? dataUrl : preview.avatar_data_url });
      } catch (error) {
        console.error('Failed to preview Character Card:', error);
        toast.error(t('settings.prompt.characterCard.errors.invalid'));
      } finally {
        setCharacterCardReading(false);
        if (characterCardInputRef.current) characterCardInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCharacterCardImport = async () => {
    if (!characterCardDialog) return;
    setCharacterCardImporting(true);
    try {
      const { prompt } = await api.importCharacterCard(characterCardDialog.file);
      setCustomPrompts(previous => [...previous.filter(item => item.id !== prompt.id), prompt]);
      setSelectedPromptId(prompt.id);
      setPromptName(prompt.name);
      setPromptDesc(prompt.description);
      setCustomContent(prompt.content);
      setPromptSections(parsePromptSections(prompt.content));
      setPromptEditorMode('advanced');
      setPromptImageUrl(prompt.image_url);
      setPendingPromptImage(null);
      setPromptImageRemoved(false);
      setLastImportedPrompt({ id: prompt.id, name: prompt.name });
      setCharacterCardDialog(null);
      toast.success(t('settings.prompt.characterCard.imported'));
    } catch (error) {
      console.error('Failed to import Character Card:', error);
      toast.error(t('settings.prompt.characterCard.errors.import'));
    } finally {
      setCharacterCardImporting(false);
    }
  };

  const handleStartCharacterChat = async () => {
    if (selectedPromptId === null || selectedPromptId > -1000 || characterChatStarting) return;
    setCharacterChatStarting(true);
    try {
      const result = await api.startCharacterCardChat(selectedPromptId);
      await onChatCreated?.(result.chat_id);
      onClose();
    } catch (error) {
      console.error('Failed to start Character Card chat:', error);
      toast.error(t('settings.prompt.characterCard.errors.startChat'));
    } finally {
      setCharacterChatStarting(false);
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
      let savedPromptId: number;
      if (selectedPromptId !== null && selectedPromptId <= -1000) {
        savedPromptId = selectedPromptId;
        await api.updateCustomPromptById(selectedPromptId, {
          name,
          description: promptDesc.trim(),
          content: customContent,
        });
      } else {
        const res = await api.createCustomPrompt({
          name,
          description: promptDesc.trim(),
          content: customContent,
        });
        savedPromptId = res.prompt_id;
      }

      let savedImageUrl = promptImageUrl;
      let imageSaveFailed = false;
      try {
        if (pendingPromptImage) {
          const imageResult = await api.setCustomPromptImage(savedPromptId, {
            base64: pendingPromptImage.base64,
            mime_type: pendingPromptImage.mimeType,
          });
          savedImageUrl = imageResult.image_url;
        } else if (promptImageRemoved) {
          await api.deleteCustomPromptImage(savedPromptId);
          savedImageUrl = null;
        }
      } catch {
        imageSaveFailed = true;
      }

      const savedPrompt: api.CustomPromptInfo = {
        id: savedPromptId,
        name,
        description: promptDesc.trim(),
        content: customContent,
        image_url: savedImageUrl,
      };
      setCustomPrompts(prev => {
        const exists = prev.some(prompt => prompt.id === savedPromptId);
        return exists
          ? prev.map(prompt => prompt.id === savedPromptId ? savedPrompt : prompt)
          : [...prev, savedPrompt];
      });
      setSelectedPromptId(savedPromptId);
      setPromptImageUrl(savedImageUrl);
      if (!imageSaveFailed) {
        setPendingPromptImage(null);
        setPromptImageRemoved(false);
        if (promptImageInputRef.current) promptImageInputRef.current.value = '';
      }
      toast.success(selectedPromptId !== null && selectedPromptId <= -1000
        ? t('settings.toasts.promptUpdated')
        : t('settings.toasts.promptCreated'));
      if (imageSaveFailed) toast.error(t('settings.prompt.imageSaveError'));
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
      toast.error(api.getApiErrorMessage(err, t('settings.toasts.promptGenerateFailed')));
    } finally {
      setAiGenerating(false);
    }
  };

  const handleAiApply = () => {
    if (aiGenerated === null) return;
    setCustomContent(aiGenerated);
    setPromptSections(parsePromptSections(aiGenerated));
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
    : !['piper', 'builtin'].includes(ttsSettings.modelId) && remoteProvidersQuery.isPending;

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

  const handleRecognitionSourceChange = (source: string) => {
    if (source !== 'local' && source !== 'server') return;
    setRecognitionSourceState(source);
    setSpeechRecognitionSource(source);
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

  const selectedPersona = personas.find(persona => persona.id === selectedPersonaId);
  const selectedPersonaIsPrimary = selectedPersona?.is_primary === 1;
  const selectedCharacterCard = customPrompts.find(prompt => prompt.id === selectedPromptId)?.character_card;

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
            {SECTIONS.filter(sec => sec.key !== 'admin' || isAdmin).map((sec) => (
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
                <label className={s.fieldLabel}>{selectedPersonaIsPrimary ? t('settings.account.name') : t('settings.account.personas.accountName')}</label>
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
                <label className={s.fieldLabel}>{t('settings.account.personas.label')}</label>
                <span className={s.fieldLabel} style={{ marginTop: '-4px', display: 'block' }}>
                  {t('settings.account.personas.help')}
                </span>
                <PromptSelector
                  options={personas.map(persona => ({
                    id: persona.id,
                    name: persona.is_primary === 1 ? t('settings.account.personas.main') : persona.name,
                    description: persona.is_primary === 1
                      ? t('settings.account.personas.accountNameValue', { name: persona.name })
                      : persona.description,
                    kind: persona.is_primary === 1 ? 'default' as const : 'custom' as const,
                  }))}
                  value={selectedPersonaId}
                  onChange={handleSelectPersona}
                  disabled={coreMemorySaving || personaDeleting}
                  placeholder={t('settings.account.personas.selectPlaceholder')}
                  maxVisibleItems={5}
                  labels={{
                    defaultBadge: t('settings.account.personas.mainBadge'),
                    customBadge: t('settings.account.personas.personaBadge'),
                    customSection: t('settings.account.personas.otherSection'),
                    createTitle: t('settings.account.personas.createTitle'),
                    createDescription: t('settings.account.personas.createDescription'),
                  }}
                />
                {!selectedPersonaIsPrimary && (
                  <>
                    <input
                      className={s.fieldInput}
                      value={personaName}
                      onChange={(e) => setPersonaName(e.target.value.slice(0, 80))}
                      placeholder={t('settings.account.personas.namePlaceholder')}
                      maxLength={80}
                    />
                    <input
                      className={s.fieldInput}
                      value={personaDescription}
                      onChange={(e) => setPersonaDescription(e.target.value.slice(0, 240))}
                      placeholder={t('settings.account.personas.descriptionPlaceholder')}
                      maxLength={240}
                    />
                  </>
                )}
                <div className={s.promptImageEditor}>
                  <div className={s.promptImagePreview}>
                    {(pendingPersonaImage?.previewUrl || personaImageUrl) ? (
                      <img src={pendingPersonaImage?.previewUrl || api.resolveImageUrl(personaImageUrl!, 320)} alt="" />
                    ) : (
                      <span>{t('settings.account.personas.imageEmpty')}</span>
                    )}
                  </div>
                  <div className={s.promptImageActions}>
                    <span className={s.fieldLabel}>{t('settings.account.personas.image')}</span>
                    <span className={s.promptImageHelp}>{t('settings.account.personas.imageHelp')}</span>
                    <div className={s.promptImageButtons}>
                      <button className={s.cancelBtn} type="button" onClick={() => personaImageInputRef.current?.click()}>
                        {t('settings.prompt.imageChoose')}
                      </button>
                      {(pendingPersonaImage || personaImageUrl) && (
                        <button className={s.cancelBtn} type="button" onClick={() => {
                          setPendingPersonaImage(null);
                          setPersonaImageUrl(null);
                          setPersonaImageRemoved(true);
                        }}>
                          {t('common.delete')}
                        </button>
                      )}
                    </div>
                    <input
                      ref={personaImageInputRef}
                      className={s.promptImageInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                      onChange={event => handlePersonaImageSelect(event.target.files?.[0])}
                    />
                  </div>
                </div>
                <label className={s.fieldLabel}>{t('settings.account.personas.coreMemory')}</label>
                <textarea
                  className={s.textareaInput}
                  value={coreMemory}
                  onChange={(e) => setCoreMemory(e.target.value)}
                  placeholder={t('settings.account.memoryPlaceholder')}
                  rows={5}
                />
                <Checkbox
                  checked={allowCoreMemoryUpdate}
                  onChange={setAllowCoreMemoryUpdate}
                  label={t('settings.account.personas.allowCoreMemoryUpdate')}
                  disabled={coreMemorySaving}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className={s.saveBtn}
                      onClick={handleSaveCoreMemory}
                      disabled={coreMemorySaving || (!selectedPersonaIsPrimary && !personaName.trim())}
                    >
                      {coreMemorySaving ? t('common.saving') : (selectedPersonaId === NEW_PERSONA_ID ? t('common.create') : t('common.save'))}
                    </button>
                    {selectedPersonaId !== null && selectedPersonaId !== NEW_PERSONA_ID && !selectedPersonaIsPrimary && (
                      <button className={s.cancelBtn} onClick={handleDeletePersona} disabled={personaDeleting} style={{ color: 'var(--color-error)' }}>
                        {personaDeleting ? t('common.deleting') : t('common.delete')}
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-hint)' }}>
                    {coreMemory.length}
                  </span>
                </div>
              </div>

                            <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.account.timezone')}</label>
                <span className={s.fieldLabel} style={{ marginTop: '-4px', display: 'block' }}>
                  {t('settings.account.timezoneHelp')}
                  {!user?.timezone_confirmed ? ` ${t('settings.account.timezoneNotConfigured')}` : ''}
                </span>
                <Select
                  options={timezoneOptions}
                  value={timezoneValue}
                  onChange={setTimezoneValue}
                  searchable
                  maxVisibleItems={7}
                />
                <button
                  className={s.saveBtn}
                  onClick={handleSaveTimezone}
                  disabled={timezoneSaving || !timezoneValue}
                >
                  {timezoneSaving ? t('common.saving') : t('common.save')}
                </button>
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

          {section === 'memory' && <GlobalMemorySettings />}

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
                      <div className={s.promptImageEditor}>
                        <div className={s.promptImagePreview}>
                          {(pendingPromptImage?.previewUrl || promptImageUrl) ? (
                            <img
                              src={pendingPromptImage?.previewUrl || api.resolveImageUrl(promptImageUrl!, 320)}
                              alt=""
                            />
                          ) : (
                            <span>{t('settings.prompt.imageEmpty')}</span>
                          )}
                        </div>
                        <div className={s.promptImageActions}>
                          <span className={s.fieldLabel}>{t('settings.prompt.image')}</span>
                          <span className={s.promptImageHelp}>{t('settings.prompt.imageHelp')}</span>
                          <div className={s.promptImageButtons}>
                            <button
                              className={s.cancelBtn}
                              type="button"
                              onClick={() => promptImageInputRef.current?.click()}
                            >
                              {t('settings.prompt.imageChoose')}
                            </button>
                            {(pendingPromptImage || promptImageUrl) && (
                              <button className={s.cancelBtn} type="button" onClick={handlePromptImageRemove}>
                                {t('common.delete')}
                              </button>
                            )}
                          </div>
                          <input
                            ref={promptImageInputRef}
                            className={s.promptImageInput}
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                            onChange={(event) => handlePromptImageSelect(event.target.files?.[0])}
                          />
                        </div>
                      </div>

                      <div className={s.promptEditorModes}>
                        <button
                          type="button"
                          className={`${s.promptEditorMode} ${promptEditorMode === 'usual' ? s.promptEditorModeActive : ''}`}
                          onClick={() => handlePromptEditorModeChange('usual')}
                        >
                          {t('settings.prompt.modeUsual')}
                        </button>
                        <button
                          type="button"
                          className={`${s.promptEditorMode} ${promptEditorMode === 'advanced' ? s.promptEditorModeActive : ''}`}
                          onClick={() => handlePromptEditorModeChange('advanced')}
                        >
                          {t('settings.prompt.modeAdvanced')}
                        </button>
                      </div>

                      {promptEditorMode === 'usual' ? (
                        <textarea
                          className={s.textareaInput}
                          value={customContent}
                          onChange={(e) => setCustomContent(e.target.value.slice(0, maxPromptLength))}
                          placeholder={t('settings.prompt.textPlaceholder')}
                          rows={8}
                          maxLength={maxPromptLength}
                        />
                      ) : (
                        <div className={s.promptAdvancedFields}>
                          {(['description', 'personality', 'scenario', 'examples', 'other'] as const).map(key => (
                            <label className={s.promptAdvancedField} key={key}>
                              <span className={s.fieldLabel}>{t(`settings.prompt.sections.${key}`)}</span>
                              <textarea
                                className={s.textareaInput}
                                value={promptSections[key]}
                                onChange={(event) => handlePromptSectionChange(key, event.target.value)}
                                placeholder={t(`settings.prompt.sectionPlaceholders.${key}`)}
                                rows={key === 'examples' ? 5 : 3}
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            className={s.saveBtn}
                            onClick={handleSaveCustomPrompt}
                            disabled={promptSaving}
                          >
                            {promptSaving ? t('common.saving') : (selectedPromptId === CUSTOM_PROMPT_ID ? t('common.create') : t('common.save'))}
                          </button>
                          {selectedCharacterCard && (
                            <button
                              className={s.saveBtn}
                              type="button"
                              onClick={() => void handleStartCharacterChat()}
                              disabled={promptSaving || characterChatStarting}
                            >
                              {characterChatStarting
                                ? t('settings.prompt.characterCard.startingChat')
                                : t('settings.prompt.characterCard.startChat')}
                            </button>
                          )}
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
                        <span style={{ fontSize: '11px', color: customContent.length >= maxPromptLength ? '#e74c3c' : 'var(--text-hint)' }}>
                          {customContent.length} / {maxPromptLength}
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

          {section === 'data' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.data')}</div>
              <p className={s.connectionsHelp}>{t('settings.data.help')}</p>

              <div className={s.voiceSectionTitle}>{t('settings.data.sillyTavern.title')}</div>
              <p className={s.connectionsHelp}>{t('settings.data.sillyTavern.help')}</p>

              <div className={s.dataImportGrid}>
                <section className={s.dataImportCard}>
                  <div>
                    <h4>{t('settings.data.backup.title')}</h4>
                    <p>{t('settings.data.backup.help')}</p>
                  </div>
                  <div className={s.dataImportActions}>
                    <button
                      className={s.cancelBtn}
                      type="button"
                      onClick={() => sillyTavernBackupInputRef.current?.click()}
                      disabled={sillyTavernBackupReading || sillyTavernBackupImporting}
                    >
                      {sillyTavernBackupReading ? t('settings.data.backup.reading') : t('settings.data.backup.button')}
                    </button>
                    <input
                      ref={sillyTavernBackupInputRef}
                      className={s.promptImageInput}
                      type="file"
                      accept=".zip,application/zip"
                      onChange={event => void handleSillyTavernBackupSelect(event.target.files?.[0])}
                    />
                  </div>
                  {lastBackupImport && (
                    <div className={s.dataImportResult}>
                      <span>{t('settings.data.backup.importedResult', {
                        characters: lastBackupImport.characters.created,
                        personas: lastBackupImport.personas.created + lastBackupImport.personas.updated,
                        chats: lastBackupImport.chats.created,
                      })}</span>
                      {lastBackupImport.chat_memory.detected > 0 && (
                        <span>{t('settings.data.backup.chatMemoryImportedResult', {
                          chats: lastBackupImport.chat_memory.indexed,
                          messages: lastBackupImport.chat_memory.messages_indexed,
                          errors: lastBackupImport.chat_memory.errors,
                        })}</span>
                      )}
                      <span>{t('settings.data.backup.mediaResult', lastBackupImport.media)}</span>
                      <span>{t('settings.data.backup.groupsResult', lastBackupImport.groups)}</span>
                      {lastBackupImport.warnings.map(warning => <span key={warning}>{t('settings.data.backup.warnings.' + warning)}</span>)}
                    </div>
                  )}
                </section>
              </div>

              <div className={s.macroFormDivider} />

              <div className={s.dataImportGrid}>
                <section className={s.dataImportCard}>
                  <div>
                    <h4>{t('settings.data.character.title')}</h4>
                    <p>{t('settings.data.character.help')}</p>
                  </div>
                  <div className={s.dataImportActions}>
                    <button className={s.cancelBtn} type="button" onClick={() => characterCardInputRef.current?.click()} disabled={characterCardReading || characterCardImporting}>
                      {characterCardReading ? t('settings.prompt.characterCard.reading') : t('settings.data.character.button')}
                    </button>
                    <input
                      ref={characterCardInputRef}
                      className={s.promptImageInput}
                      type="file"
                      accept=".json,.png,application/json,image/png"
                      onChange={event => handleCharacterCardSelect(event.target.files?.[0])}
                    />
                  </div>
                  {lastImportedPrompt && (
                    <div className={s.dataImportResult}>
                      <span>{t('settings.data.character.imported', { name: lastImportedPrompt.name })}</span>
                      <button className={s.cancelBtn} type="button" onClick={() => setSection('prompt')}>{t('settings.data.openCharacter')}</button>
                    </div>
                  )}
                </section>

                <section className={s.dataImportCard}>
                  <div>
                    <h4>{t('settings.data.personas.title')}</h4>
                    <p>{t('settings.data.personas.help')}</p>
                  </div>
                  <div className={s.dataImportActions}>
                    <button className={s.cancelBtn} type="button" onClick={() => personaImportInputRef.current?.click()} disabled={personaImportReading || personaImporting}>
                      {personaImportReading ? t('common.loading') : t('settings.data.personas.button')}
                    </button>
                    <input
                      ref={personaImportInputRef}
                      className={s.promptImageInput}
                      type="file"
                      accept="application/json,.json"
                      onChange={event => handlePersonaImportSelect(event.target.files?.[0])}
                    />
                  </div>
                  {lastPersonaImport && (
                    <div className={s.dataImportResult}>
                      <span>{t('settings.data.personas.imported', { created: lastPersonaImport.created, updated: lastPersonaImport.updated })}</span>
                      <button className={s.cancelBtn} type="button" onClick={() => setSection('account')}>{t('settings.data.openPersonas')}</button>
                    </div>
                  )}
                </section>

                <section className={s.dataImportCard}>
                  <div>
                    <h4>{t('settings.data.chats.title')}</h4>
                    <p>{t('settings.data.chats.help')}</p>
                  </div>
                  <div className={s.dataImportActions}>
                    <button className={s.cancelBtn} type="button" onClick={() => sillyTavernChatInputRef.current?.click()} disabled={sillyTavernChatsReading || sillyTavernChatsImporting}>
                      {sillyTavernChatsReading ? t('common.loading') : t('settings.data.chats.button')}
                    </button>
                    <input
                      ref={sillyTavernChatInputRef}
                      className={s.promptImageInput}
                      type="file"
                      multiple
                      accept=".jsonl,application/json"
                      onChange={event => void handleSillyTavernChatSelect(event.target.files)}
                    />
                  </div>
                  {lastChatImport && (
                    <div className={s.dataImportResult}>
                      <span>{t('settings.data.chats.importedResult', {
                        created: lastChatImport.filter(result => result.status === 'created').length,
                        existing: lastChatImport.filter(result => result.status === 'existing').length,
                      })}</span>
                      <button
                        className={s.cancelBtn}
                        type="button"
                        onClick={async () => {
                          const target = lastChatImport[lastChatImport.length - 1];
                          if (!target) return;
                          await onChatCreated?.(target.chat_id);
                          onClose();
                        }}
                      >
                        {t('settings.data.openChat')}
                      </button>
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {section === 'voice' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.voice')}</div>

              <div className={s.voiceSectionTitle}>{t('settings.voice.recognitionTitle')}</div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.voice.recognitionSource')}</label>
                <Select
                  options={recognitionSourceOptions}
                  value={recognitionSource}
                  onChange={handleRecognitionSourceChange}
                  disabled={transcriptionStatusQuery.isPending}
                />
                <div className={s.voiceHint}>{t('settings.voice.recognitionSourceHint')}</div>
              </div>
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
                  disabled={!piperVoicesReady || !remoteProvidersReady}
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

          {section === 'browser' && (
            <BrowserSettings />
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
                        checked={!featureFlags.disable_prompt_injection_protection}
                        onChange={() => handleToggleFlag('disable_prompt_injection_protection')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.injectionProtection')}</div>
                        <Tooltip content={t('settings.restrictions.injectionProtectionHelp')}>
                          <span tabIndex={0} style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>{t('settings.restrictions.injectionProtectionHint')}</span>
                        </Tooltip>
                      </div>
                    </label>
                  </div>

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
                        checked={featureFlags.disable_avatar_control}
                        onChange={() => handleToggleFlag('disable_avatar_control')}
                        disabled={flagsSaving}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.restrictions.noAvatarControl')}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                          {t('settings.restrictions.noAvatarControlHelp')}
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

              <SubagentModelSettings
                models={modelsCatalog}
                model={subagentModel}
                modelSaving={subagentModelSaving}
                reasoningLevel={subagentReasoningLevel}
                reasoningLevels={subagentAvailableReasoningLevels}
                reasoningSaving={subagentReasoningSaving}
                onModelChange={handleSubagentModelChange}
                onReasoningChange={setSubagentReasoningLevelState}
                onReasoningCommit={handleSubagentReasoningCommit}
              />

              {modelsLoading ? (
                <div className={s.promptLoading}>{t('common.loading')}</div>
              ) : modelsCatalog.length === 0 ? (
                <div className={s.fieldLabel}>{t('settings.models.empty')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {modelsCatalog.map((model) => {
                    const settings = modelSettingsMap[model.id] || {};
                    const isSaving = modelsSavingId === model.id;
                    // Missing capabilities on older servers are unknown; [] explicitly means none.
                    const supported = model.supported_params == null ? null : new Set(model.supported_params);
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
                          ).filter((param) => supported === null || supported.has(param.key)).map((param) => {
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
                <label className={s.fieldLabel}>{t('settings.app.theme')}</label>
                <Select
                  options={themeOptions}
                  value={themePreference}
                  onChange={handleThemeChange}
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

              <div className={s.voiceDivider} />
              <div className={s.voiceSectionTitle}>{t('settings.app.desktopBrowserTitle')}</div>

              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>{t('settings.app.desktopBrowserConcurrency')}</label>
                <Select
                  options={desktopBrowserConcurrencyOptions}
                  value={String(desktopBrowserSettings.concurrency)}
                  onChange={(value) => void saveDesktopBrowserSettings({ ...desktopBrowserSettings, concurrency: Number(value) })}
                  disabled={desktopBrowserSettingsSaving}
                />
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  {t('settings.app.desktopBrowserConcurrencyHelp')}
                </div>
              </div>

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={desktopBrowserSettings.searchEnabled}
                  onChange={(checked) => void saveDesktopBrowserSettings({ ...desktopBrowserSettings, searchEnabled: checked })}
                  label={t('settings.app.desktopSearch')}
                  disabled={desktopBrowserSettingsSaving}
                />
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  {t('settings.app.desktopSearchHelp')}
                </div>
              </div>

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={desktopBrowserSettings.readerEnabled}
                  onChange={(checked) => void saveDesktopBrowserSettings({ ...desktopBrowserSettings, readerEnabled: checked })}
                  label={t('settings.app.desktopReader')}
                  disabled={desktopBrowserSettingsSaving}
                />
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                  {t('settings.app.desktopReaderHelp')}
                </div>
              </div>

              <div className={s.voiceDivider} />

              <div className={s.fieldGroup}>
                <Checkbox
                  checked={uiSettings.show_tokens !== false}
                  onChange={handleToggleShowTokens}
                  label={t('settings.app.showTokens')}
                  disabled={uiSettingsSaving}
                />
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

          {section === 'admin' && isAdmin && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.admin')}</div>
              <ChatGptSettings />
            </div>
          )}

          {section === 'about' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>{t('settings.sections.about')}</div>
              <AboutSettings />
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
      {promptImageCropSource && (
        <PromptImageCropDialog
          sourceUrl={promptImageCropSource}
          onCancel={() => setPromptImageCropSource(null)}
          onConfirm={image => {
            setPendingPromptImage(image);
            setPromptImageRemoved(false);
            setPromptImageCropSource(null);
          }}
        />
      )}
      {personaImageCropSource && (
        <PromptImageCropDialog
          sourceUrl={personaImageCropSource}
          onCancel={() => setPersonaImageCropSource(null)}
          onConfirm={image => {
            setPendingPersonaImage(image);
            setPersonaImageRemoved(false);
            setPersonaImageCropSource(null);
          }}
        />
      )}
      {personaImportDialog && (
        <PersonaImportDialog
          preview={personaImportDialog.preview}
          importing={personaImporting}
          onCancel={() => !personaImporting && setPersonaImportDialog(null)}
          onImport={handlePersonaImport}
        />
      )}
      {sillyTavernBackupDialog && (
        <SillyTavernBackupImportDialog
          preview={sillyTavernBackupDialog.preview}
          importing={sillyTavernBackupImporting}
          progress={backupImportProgress}
          onCancel={() => {
            void api.cancelSillyTavernBackup(sillyTavernBackupDialog.importId).catch(() => toast.error(t('settings.data.backup.errors.import')));
            if (!sillyTavernBackupImporting) setSillyTavernBackupDialog(null);
          }}
          onImport={handleSillyTavernBackupImport}
        />
      )}
      {sillyTavernChatDialog && (
        <SillyTavernChatImportDialog
          previews={sillyTavernChatDialog.previews}
          importing={sillyTavernChatsImporting}
          onCancel={() => !sillyTavernChatsImporting && setSillyTavernChatDialog(null)}
          onImport={handleSillyTavernChatImport}
        />
      )}
      {characterCardDialog && (
        <CharacterCardImportDialog
          preview={characterCardDialog.preview}
          imageUrl={characterCardDialog.imageUrl}
          importing={characterCardImporting}
          onCancel={() => !characterCardImporting && setCharacterCardDialog(null)}
          onImport={handleCharacterCardImport}
        />
      )}
    </motion.div>
  );
}
