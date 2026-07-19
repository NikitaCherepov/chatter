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

export type PineconeSettings = {
  apiKey: string;
  hasApiKey: boolean;
  indexName: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  hasEmbeddingApiKey: boolean;
  embeddingModel: string;
};

export type WebSearchSettings = {
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
};

export type WebReaderSettings = {
  baseUrl: string;
  token: string;
  hasToken: boolean;
};

export type CloudTtsSettings = {
  apiKey: string;
  hasApiKey: boolean;
  model: string;
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
  pinecone: PineconeSettings;
  webSearch: WebSearchSettings;
  webReader: WebReaderSettings;
  cloudTts: CloudTtsSettings;
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
  pinecone: {
    apiKey: '',
    hasApiKey: false,
    indexName: 'bot-memory',
    embeddingBaseUrl: 'https://openrouter.ai/api/v1',
    embeddingApiKey: '',
    hasEmbeddingApiKey: false,
    embeddingModel: 'text-embedding-3-small',
  },
  webSearch: {
    baseUrl: 'https://api.tavily.com',
    apiKey: '',
    hasApiKey: false,
  },
  webReader: {
    baseUrl: 'https://production-sfo.browserless.io',
    token: '',
    hasToken: false,
  },
  cloudTts: {
    apiKey: '',
    hasApiKey: false,
    model: 'sonic-3.5',
  },
};
