/**
 * Static catalog of known models for providers with a fixed lineup
 * (DeepSeek, Xiaomi). Prices are USD per 1 million tokens.
 *
 * For OpenRouter, models and prices are fetched dynamically via the
 * /api/openrouter/models endpoint — see OpenRouterModelInput.
 *
 * Users can always pick "Other…" in the dropdown and type a custom
 * model id; these presets are just a convenience for the common case.
 */

export type ModelPrices = {
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
};

export type PresetModel = {
  /** Model id to store in config (what the provider expects in `model` field). */
  id: string;
  /** Human-readable name for the dropdown. */
  name: string;
  /** Pricing snapshot (per 1M tokens). */
  prices: ModelPrices;
};

export const DEEPSEEK_PRESET_MODELS: PresetModel[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    prices: {
      inputPricePerMillion: 0.14,
      outputPricePerMillion: 0.28,
      cacheReadPricePerMillion: 0.0028,
    },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    prices: {
      inputPricePerMillion: 0.435,
      outputPricePerMillion: 0.87,
      cacheReadPricePerMillion: 0.0036,
    },
  },
];

export const XIAOMI_PRESET_MODELS: PresetModel[] = [
  {
    id: 'mimo-v2.5',
    name: 'MiMo V2.5',
    prices: {
      inputPricePerMillion: 0.14,
      outputPricePerMillion: 0.28,
      cacheReadPricePerMillion: 0.0028,
    },
  },
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    prices: {
      inputPricePerMillion: 0.435,
      outputPricePerMillion: 0.87,
      cacheReadPricePerMillion: 0.0036,
    },
  },
];

/**
 * Format price for compact display in hints.
 * Big numbers get more precision, tiny ones get scientific-ish.
 */
export const formatPriceShort = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  if (n >= 0.0001) return n.toFixed(5);
  return n.toExponential(2).replace('e-', 'e-');
};

/**
 * Format prices as "in / out / cache" string for the provider dropdown hint.
 */
export const formatPricesHint = (mp: ModelPrices | null): string => {
  if (!mp) return 'no pricing';
  const inP = formatPriceShort(mp.inputPricePerMillion);
  const outP = formatPriceShort(mp.outputPricePerMillion);
  const cacheP = mp.cacheReadPricePerMillion !== null
    ? formatPriceShort(mp.cacheReadPricePerMillion)
    : '—';
  return `in $${inP} / out $${outP} / cache $${cacheP} per 1M`;
};

/**
 * Min across an array of ModelPrices (per field).
 */
export const minModelPrices = (list: ModelPrices[]): ModelPrices | null => {
  if (list.length === 0) return null;
  const input = list.reduce((a, b) => Math.min(a, b.inputPricePerMillion ?? Infinity), Infinity);
  const output = list.reduce((a, b) => Math.min(a, b.outputPricePerMillion ?? Infinity), Infinity);
  const cache = list.reduce((a, b) => Math.min(a, b.cacheReadPricePerMillion ?? Infinity), Infinity);
  return {
    inputPricePerMillion: Number.isFinite(input) ? input : null,
    outputPricePerMillion: Number.isFinite(output) ? output : null,
    cacheReadPricePerMillion: Number.isFinite(cache) ? cache : null,
  };
};

/**
 * Max across an array of ModelPrices (per field).
 */
export const maxModelPrices = (list: ModelPrices[]): ModelPrices | null => {
  if (list.length === 0) return null;
  const input = list.reduce((a, b) => Math.max(a, b.inputPricePerMillion ?? -Infinity), -Infinity);
  const output = list.reduce((a, b) => Math.max(a, b.outputPricePerMillion ?? -Infinity), -Infinity);
  const cache = list.reduce((a, b) => Math.max(a, b.cacheReadPricePerMillion ?? -Infinity), -Infinity);
  return {
    inputPricePerMillion: Number.isFinite(input) ? input : null,
    outputPricePerMillion: Number.isFinite(output) ? output : null,
    cacheReadPricePerMillion: Number.isFinite(cache) ? cache : null,
  };
};

/**
 * Format price range as "in $min-max / out $min-max / cache $min-max per 1M".
 */
export const formatPricesRangeHint = (min: ModelPrices, max: ModelPrices): string => {
  const inRange = formatPriceShort(min.inputPricePerMillion) + '-' + formatPriceShort(max.inputPricePerMillion);
  const outRange = formatPriceShort(min.outputPricePerMillion) + '-' + formatPriceShort(max.outputPricePerMillion);
  const cacheRange = (min.cacheReadPricePerMillion !== null && max.cacheReadPricePerMillion !== null)
    ? formatPriceShort(min.cacheReadPricePerMillion) + '-' + formatPriceShort(max.cacheReadPricePerMillion)
    : '—';
  return `in $${inRange} / out $${outRange} / cache $${cacheRange} per 1M`;
};
