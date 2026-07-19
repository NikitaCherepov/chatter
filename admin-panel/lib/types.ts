export type ProviderModelConfig = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
};

export type ManualModelConfig = ProviderModelConfig & {
  name: string;
  description: string;
  uniqueId: string;
  supportsVision: boolean;
  adminOnly: boolean;
};

export type Settings = {
  telegramEnabled: boolean;
  notesEnabled: boolean;
  notesUrl: string;
  aiBaseUrl: string;
  aiModel: string;
  voiceMode: 'off' | 'local' | 'remote';
  voiceExternalUrl: string;
  hasTelegramToken: boolean;
  hasAiApiKey: boolean;
  hasVoiceToken: boolean;
  proModels: ProviderModelConfig[];
  liteModels: ProviderModelConfig[];
  visionModel: ProviderModelConfig;
  manualModels: ManualModelConfig[];
};

export type Service = { service: string; state: string; health: string; status: string };

export const emptySettings: Settings = {
  telegramEnabled: false,
  notesEnabled: false,
  notesUrl: '',
  aiBaseUrl: 'https://openrouter.ai/api/v1',
  aiModel: '',
  voiceMode: 'off',
  voiceExternalUrl: '',
  hasTelegramToken: false,
  hasAiApiKey: false,
  hasVoiceToken: false,
  proModels: [
    {
      id: 'pro-new-0',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: '',
      apiKey: '',
      hasApiKey: false,
    },
  ],
  liteModels: [],
  visionModel: {
    id: 'vision',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    apiKey: '',
    hasApiKey: false,
  },
  manualModels: [],
};
