import { WAKE_WORD_CHOICES } from '../../main/wakeword-config';

/** Stable IDs shared by the catalog, search and section adapters. */
export const SECTION_SETTING_KEYS: Record<string, Record<string, string>> = {
  voice: { recognitionSource: 'settings.voice.recognitionSource', recognitionLanguage: 'settings.voice.recognitionLanguage',
    modelId: 'settings.voice.model', voiceId: 'settings.voice.voicePlaceholder', volume: 'settings.voice.speechVolume', sfxVolume: 'settings.voice.effectsVolume',
    wakeEnabled: 'settings.voice.activation.enabled', wakeSensitivity: 'settings.voice.activation.sensitivity',
    ...Object.fromEntries(WAKE_WORD_CHOICES.map(word => [`wake_${word.id}`, word.label])) },
  account: { name: 'settings.account.personas.accountName', timezone: 'settings.account.timezone' },
  limits: { contextTokens: 'settings.app.contextLimit', attachmentTokens: 'settings.app.attachmentLimit',
    browserConcurrency: 'settings.app.layout.desktopBrowserConcurrency', desktopSearch: 'settings.app.layout.desktopSearch', desktopReader: 'settings.app.layout.desktopReader' },
  agents: { model: 'settings.app.subagentModel', reasoning: 'settings.app.reasoning' },
  memory: { automaticMemory: 'chat.memory.automaticMemory.label', resultLimit: 'chat.memory.preferences.limitLabel' },
  browser: { autoOpen: 'settings.browser.open', autoClick: 'settings.browser.click', autoFill: 'settings.browser.fill', humanTyping: 'settings.browser.humanTyping' },
};
