import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { PromptSelector } from './PromptSelector';
import { getTtsModels, getTtsSettings, setTtsSettings, ttsPreview, ttsStopPreview, getVoicesForModel } from '../lib/tts';
import type { TtsSettings } from '../lib/tts';
import { Select } from './Select';
import type { SelectOption } from './Select';
import s from './SettingsModal.module.scss';

type Props = {
  onClose: () => void;
};

type Section = 'account' | 'prompt' | 'voice' | 'app';

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

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'account', label: 'Аккаунт' },
  { key: 'prompt', label: 'Промпт' },
  { key: 'voice', label: 'Голос' },
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
  const [selectedPromptId, setSelectedPromptId] = useState<number | null>(null);
  const [customContent, setCustomContent] = useState('');
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);

  // App zoom (stored as honest percentages)
  const [zoomPct, setZoomPct] = useState(100);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomInputValue, setZoomInputValue] = useState('100');

  // Voice / TTS
  const [ttsModels] = useState(() => getTtsModels());
  const [ttsSettings, setTtsSettingsState] = useState<TtsSettings>(() => getTtsSettings());
  const [previewPlaying, setPreviewPlaying] = useState(false);

  // Load account data
  useEffect(() => {
    if (user) {
      setNameValue(user.name || '');
    }
  }, [user]);

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
        // If user hasn't chosen a prompt, fall back to the default one
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

  const handleSelectPrompt = async (promptId: number) => {
    setSelectedPromptId(promptId);
    setPromptSaving(true);
    try {
      await api.selectPrompt(promptId);
      toast.success(promptId === CUSTOM_PROMPT_ID ? 'Выбран кастомный промпт' : 'Промпт выбран');
    } catch (err) {
      console.error('Failed to select prompt:', err);
      toast.error('Не удалось выбрать промпт');
    } finally {
      setPromptSaving(false);
    }
  };

  const handleSaveCustomPrompt = async () => {
    setPromptSaving(true);
    try {
      await api.updateCustomPrompt(customContent);
      toast.success('Кастомный промпт сохранён');
    } catch (err) {
      console.error('Failed to save custom prompt:', err);
      toast.error('Не удалось сохранить промпт');
    } finally {
      setPromptSaving(false);
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
    const voices = getVoicesForModel(modelId);
    const newSettings: TtsSettings = {
      modelId,
      voiceId: voices.length > 0 ? voices[0].id : '',
      volume: ttsSettings.volume,
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

  const handlePreview = () => {
    ttsStopPreview();
    setPreviewPlaying(false);
    setTimeout(() => {
      setPreviewPlaying(true);
      ttsPreview(ttsSettings.modelId, ttsSettings.voiceId);
      // Auto-reset after 5s safety net (piper generation can be slow)
      setTimeout(() => setPreviewPlaying(false), 5000);
    }, 50);
  };

  return (
    <motion.div
      className={s.overlay}
      onClick={onClose}
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
                      options={prompts}
                      value={selectedPromptId}
                      onChange={handleSelectPrompt}
                      disabled={promptSaving}
                      maxVisibleItems={3}
                    />
                  </div>

                  {selectedPromptId === CUSTOM_PROMPT_ID && (
                    <div className={s.fieldGroup}>
                      <label className={s.fieldLabel}>Ваш промпт</label>
                      <textarea
                        className={s.textareaInput}
                        value={customContent}
                        onChange={(e) => setCustomContent(e.target.value)}
                        placeholder="Опишите стиль общения..."
                        rows={6}
                      />
                      <button
                        className={s.saveBtn}
                        onClick={handleSaveCustomPrompt}
                        disabled={promptSaving}
                      >
                        {promptSaving ? 'Сохранение...' : 'Сохранить промпт'}
                      </button>
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
                    <Select
                      options={voiceOptions}
                      value={ttsSettings.voiceId}
                      onChange={handleVoiceChange}
                      placeholder="Выберите голос..."
                      searchable
                      maxVisibleItems={6}
                    />
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
                <label className={s.fieldLabel}>Громкость</label>
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
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
