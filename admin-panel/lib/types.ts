export type ProviderModelConfig = {
  id: string;
  baseUrl: string;
  proxyUrl?: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  /** Stable id used to look up coefficient in model_overrides. Auto-generated server-side if empty. */
  uniqueId?: string;
  /** Whether this model accepts OpenAI-compatible tool definitions. */
  supportsTools?: boolean;
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
  isFree: boolean;
  /** Admin-set display tier 1..3 shown in the desktop model selector (null = unset). */
  intelTier: number | null;
  /** Admin-set price tier 1..3 ($ / $$ / $$$) (null = unset). */
  priceTier: number | null;
  /** Locally measured generation speed, EMA (tokens/sec). */
  avgTps: number | null;
  tpsSamples: number | null;
  /** Maximum total context accepted by the configured model/provider. */
  contextLength: number | null;
};

export type ManualModelConfig = ProviderModelConfig & {
  name: string;
  description: string;
  uniqueId: string;
  supportsVision: boolean;
  supportsTools: boolean;
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
  enabled: boolean;
  searxngEnabled: boolean;
  engines: Record<'google' | 'brave' | 'duckduckgo' | 'startpage' | 'wikipedia', boolean>;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
};

export type WebReaderSettings = {
  enabled: boolean;
  desktopEnabled: boolean;
  browserlessEnabled: boolean;
  baseUrl: string;
  token: string;
  hasToken: boolean;
};

export type CloudTtsSettings = {
  apiKey: string;
  hasApiKey: boolean;
  model: string;
};

/** Allowlist for one request parameter; `default` is used when the tool call omits it. */
export type ImageGenParamPolicy = {
  allowed: string[];
  default: string;
};

/**
 * Mirrors the backend runtime-patch contract (the manager forwards this
 * object verbatim to the backend on save). Secrets are referenced by their
 * encrypted API-key-vault IDs; raw secret fields stay empty in the browser.
 * `hasApiKey`/`hasApiToken` are UI-only availability flags.
 */
export type ImageGenerationSettings = {
  enabled: boolean;
  img2imgEnabled: boolean;
  provider: 'openrouter' | 'cloudflare';
  openrouter: {
    apiKeyId: number | null;
    apiKey: string;
    hasApiKey: boolean;
    baseUrl: string;
    model: {
      id: string;
      name: string;
      capabilities?: unknown;
      params: {
        resolution: ImageGenParamPolicy | null;
        quality: ImageGenParamPolicy | null;
      };
    };
  };
  cloudflare: {
    apiTokenId: number | null;
    apiToken: string;
    hasApiToken: boolean;
    accountId: string;
    model: {
      id: string;
      name: string;
      capabilities?: unknown;
      params: {
        quality: ImageGenParamPolicy | null;
      };
    };
  };
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
    proxyUrl: '',
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
    enabled: true,
    searxngEnabled: true,
    engines: {
      google: true,
      brave: true,
      duckduckgo: true,
      startpage: true,
      wikipedia: true,
    },
    baseUrl: 'https://api.tavily.com',
    apiKey: '',
    hasApiKey: false,
  },
  webReader: {
    enabled: true,
    desktopEnabled: true,
    browserlessEnabled: true,
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
    enabled: true,
    img2imgEnabled: true,
    provider: 'openrouter',
    openrouter: {
      apiKeyId: null,
      apiKey: '',
      hasApiKey: false,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: {
        id: 'x-ai/grok-imagine-image-quality',
        name: 'Grok Imagine',
        capabilities: null,
        params: {
          resolution: { allowed: ['2K'], default: '2K' },
          quality: null,
        },
      },
    },
    cloudflare: {
      apiTokenId: null,
      apiToken: '',
      hasApiToken: false,
      accountId: '',
      model: {
        id: '@cf/black-forest-labs/flux-2-klein-4b',
        name: 'FLUX.2 [klein] 4B',
        capabilities: null,
        params: {
          quality: { allowed: ['auto', 'low', 'medium', 'high'], default: 'auto' },
        },
      },
    },
  },
};
