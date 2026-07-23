export type ProviderModelConfig = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  /** Stable id used to look up coefficient in model_overrides. Auto-generated server-side if empty. */
  uniqueId?: string;
};

export type ProviderKind = 'openrouter' | 'deepseek' | 'xiaomi' | 'custom' | null;
export type PricingMode = 'auto' | 'manual' | null;

export type ModelOverrideData = {
  providerKind: ProviderKind;
  openrouterProviderSlug: string | null;
  pricingMode: PricingMode;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
  pricingSource: string | null;
  pricingUpdatedAt: number | null;
  selectedApiKeyId: number | null;
};

export type ManualModelConfig = ProviderModelConfig & {
  name: string;
  description: string;
  uniqueId: string;
  supportsVision: boolean;
  adminOnly: boolean;
  /** Token quota coefficient. 0 = free model, 1 = default, 0.7 = cheaper, 1.5 = expensive. */
  coefficient?: number;
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

export type ImageGenerationSettings = {
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  model: string;
  maxResolution: '1K' | '2K';
  quality: 'auto' | 'low' | 'medium' | 'high';
  supportedParameters: string[];
};

export type Settings = {
  telegramEnabled: boolean;
  telegramRichStreaming: boolean;
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
  imageGeneration: ImageGenerationSettings;
};

export type Service = { service: string; state: string; health: string; status: string };

export type ApiKey = {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  updated_at: string;
};

// When fetching a single key with the decrypted value:
export type ApiKeyValue = ApiKey & {
  key: string;
};


export const emptySettings: Settings = {
  telegramEnabled: false,
  telegramRichStreaming: true,
  notesEnabled: false,
  notesUrl: '',
  aiBaseUrl: 'https://openrouter.ai/api/v1',
  aiModel: '',
  voiceMode: 'off',
  voiceExternalUrl: '',
  hasTelegramToken: false,
  hasAiApiKey: false,
  hasVoiceToken: false,
  proModels: [],
  liteModels: [],
  visionModel: {
    id: 'vision',
    baseUrl: '',
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
  imageGeneration: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    hasApiKey: false,
    model: 'x-ai/grok-imagine-image-quality',
    maxResolution: '2K',
    quality: 'auto',
    supportedParameters: ['resolution', 'input_references'],
  },
};
