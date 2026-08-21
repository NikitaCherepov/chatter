import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ApiKey,
  ApiKeyValue,
  ModelOverrideData,
  ProviderKind,
  ProviderModelConfig,
} from '../../../lib/types';
import {
  DEEPSEEK_PRESET_MODELS,
  XIAOMI_PRESET_MODELS,
  formatPricesHint,
  formatPricesRangeHint,
  minModelPrices,
  maxModelPrices,
  type ModelPrices,
} from '../../../lib/presetModels';
import { api } from '../../../lib/api';
import { useOpenRouterMonitorStatus } from '../../../lib/useOpenRouterMonitor';
import { Select, type SelectBadge, type SelectOption } from '../../ui/Select/Select';
import { formatContextLength } from '../../ui/ModelInput/ModelInput.utils';
import {
  OpenRouterModelInput,
  PresetModelInput,
  pricingToModelPrices,
  parseUserPrice,
  type OpenRouterPricing,
} from '../../ui/ModelInput';
import { FormField } from '../../ui/FormField/FormField';
import { Toggle } from '../../ui/Toggle/Toggle';
import { SecretState } from '../../ui/SecretState/SecretState';
import { usePersistentOpenState } from '../../../lib/usePersistentOpenState';
import { AnimatedDetails } from './AnimatedDetails';
import { DragGrip, ModelOverlaySummary, SortableModelsDnd } from './SortableModels';
import styles from './ModelsPage.module.css';

type CoefficientManager = {
  get?: (uniqueId: string | undefined | null) => number | undefined;
  set?: (uniqueId: string, coefficient: number) => void;
  save?: (uniqueId: string, coefficient: number) => void | Promise<void>;
  getOverride?: (uniqueId: string | undefined | null) => ModelOverrideData | undefined;
  saveOverride?: (uniqueId: string, data: Partial<ModelOverrideData>) => void | Promise<void>;
};

type Props = {
  title?: string;
  description?: string;
  models: ProviderModelConfig[];
  onChange: (models: ProviderModelConfig[]) => void;
  required?: boolean;
  emptyText?: string;
  coefficientManager?: CoefficientManager;
  /** localStorage key suffix for persisted open/closed cards. */
  storageKey?: string;
};

const newModel = (): ProviderModelConfig => ({
  id: `new-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  baseUrl: '',
  proxyUrl: '',
  model: '',
  apiKey: '',
  hasApiKey: false,
});

// ── Card summary chips (at-a-glance info on collapsed cards) ─────────────────

const PROVIDER_CHIP_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xiaomi: 'Xiaomi',
};

function formatPriceChip(value: number | null | undefined) {
  return value == null ? '—' : String(value);
}

export function ModelSummaryChips({
  providerKind,
  prices,
  coefficient,
  badges,
}: {
  providerKind?: string | null;
  prices?: { input?: number | null; output?: number | null } | null;
  coefficient?: number;
  badges?: string[];
}) {
  const { t } = useTranslation();
  const providerLabel = providerKind
    ? (PROVIDER_CHIP_LABELS[providerKind] ?? t('models.billing.customProvider') ?? 'Custom')
    : null;
  const hasPrices = Boolean(prices && (prices.input != null || prices.output != null));
  return (
    <span className={styles.summaryChips}>
      {providerLabel && <span className={styles.chip}>{providerLabel}</span>}
      {hasPrices && prices && (
        <span className={styles.chip} title="$/1M">
          <em>in</em> {formatPriceChip(prices.input)} · <em>out</em>{' '}
          {formatPriceChip(prices.output)}
        </span>
      )}
      {typeof coefficient === 'number' && coefficient !== 1 && (
        <span className={styles.chip}>×{coefficient}</span>
      )}
      {badges?.map((badge) => (
        <span key={badge} className={styles.chip}>
          {badge}
        </span>
      ))}
    </span>
  );
}

export function ModelListEditor({
  title,
  description,
  models,
  onChange,
  required = false,
  emptyText,
  coefficientManager,
  storageKey = 'models',
}: Props) {
  const { t } = useTranslation();
  const { isOpen, setOpen, setAll } = usePersistentOpenState(`cards:${storageKey}`);
  const update = (index: number, patch: Partial<ProviderModelConfig>) => {
    onChange(models.map((model, i) => (i === index ? { ...model, ...patch } : model)));
  };
  // uniqueId is stable across saves (the server preserves it); the index-based
  // `id` is regenerated on every save, so it must not key React state.
  const cardKey = (model: ProviderModelConfig) => model.uniqueId?.trim() || model.id;

  return (
    <div className={styles.modelList}>
      {(title || description) && (
        <div className={styles.listHeading}>
          <div>
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
        </div>
      )}
      {!models.length && (
        <p className={styles.empty}>{emptyText || t('models.common.emptyText')}</p>
      )}
      {models.length > 1 && (
        <div className={styles.listToolbar}>
          <button
            className="buttonSecondary"
            type="button"
            onClick={() => setAll(models.map(cardKey), true)}
          >
            {t('models.common.expandAll')}
          </button>
          <button
            className="buttonSecondary"
            type="button"
            onClick={() => setAll(models.map(cardKey), false)}
          >
            {t('models.common.collapseAll')}
          </button>
        </div>
      )}
      <SortableModelsDnd
        items={models}
        onReorder={onChange}
        keyOf={cardKey}
        renderOverlay={(model, order) => (
          <ModelOverlaySummary
            order={order}
            title={model.model || t('models.common.newModel')}
            subtitle={model.baseUrl || t('models.common.providerNotSet')}
          />
        )}
      >
        {(model, index, dragHandleProps) => {
          const key = cardKey(model);
          return (
            <div className={styles.modelSequence}>
              {index > 0 && (
                <span className={styles.nextLabel}>{t('models.common.nextModel')}</span>
              )}
              <AnimatedDetails
                className={styles.modelCard}
                open={isOpen(key, index === 0)}
                onToggle={(next) => setOpen(key, next)}
                summary={
                  <>
                    <DragGrip
                      dragHandleProps={dragHandleProps}
                      title={t('models.common.dragToReorder')}
                    />
                    <span className={styles.order}>{index + 1}</span>
                    <span className={styles.modelTitle}>
                      <strong>{model.model || t('models.common.newModel')}</strong>
                      <span>{model.baseUrl || t('models.common.providerNotSet')}</span>
                    </span>
                    <ModelSummaryChips
                      providerKind={
                        coefficientManager?.getOverride?.(model.uniqueId)?.providerKind ||
                        resolveProviderKind(model.baseUrl)
                      }
                      prices={
                        coefficientManager?.getOverride?.(model.uniqueId)
                          ? {
                              input: coefficientManager.getOverride?.(model.uniqueId)
                                ?.inputPricePerMillion,
                              output: coefficientManager.getOverride?.(model.uniqueId)
                                ?.outputPricePerMillion,
                            }
                          : null
                      }
                      coefficient={coefficientManager?.get?.(model.uniqueId)}
                    />
                    <SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />
                  </>
                }
              >
                <div className={styles.modelBody}>
                  <ProviderModelFields
                    model={model}
                    onChange={(p) => update(index, p)}
                    coefficientManager={coefficientManager}
                  />
                  <div className={styles.modelActions}>
                    <button
                      className={styles.dangerButton}
                      type="button"
                      disabled={required && models.length === 1}
                      onClick={() => onChange(models.filter((_, i) => i !== index))}
                    >
                      {t('models.common.remove')}
                    </button>
                  </div>
                </div>
              </AnimatedDetails>
            </div>
          );
        }}
      </SortableModelsDnd>
      <button
        className="buttonSecondary"
        type="button"
        onClick={() => onChange([...models, newModel()])}
      >
        {t('models.common.addModel')}
      </button>
    </div>
  );
}

// ── Provider type helpers ────────────────────────────────────────────────────

const PROVIDER_URLS: Record<NonNullable<ProviderKind>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  custom: '',
};

const API_KEYS_CHANGED_EVENT = 'chatter:api-keys-changed';

export function resolveProviderKind(baseUrl: string): ProviderKind {
  const url = baseUrl.toLowerCase();
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('xiaomimimo.com')) return 'xiaomi';
  return 'custom';
}

// ── OpenRouter endpoints helper (dynamic upstream providers) ─────────────────

type OrEndpoint = {
  tag?: string;
  provider_name?: string;
  name?: string;
  pricing?: OpenRouterPricing;
  quantization?: string | null;
  context_length?: number | null;
  status?: string | number | null;
  /** Uptime score for the last day, 0..100. */
  uptime_last_1d?: number | null;
};

type ModelEndpointsResult = {
  options: SelectOption[];
  /** Map of base slug → prices. */
  pricesBySlug: Map<string, ModelPrices | null>;
  basePrices: ModelPrices | null;
};

// ── Providers name cache ─────────────────────────────────────────────────────

let _providerNames: Map<string, string> | null = null;
let _providerNamesAt = 0;
const PROVIDER_NAMES_TTL_MS = 30 * 60 * 1000;

async function loadProviderNames(): Promise<Map<string, string>> {
  if (_providerNames && Date.now() - _providerNamesAt < PROVIDER_NAMES_TTL_MS) {
    return _providerNames;
  }
  try {
    const data = await api<{ data?: Array<{ slug?: string; name?: string }> }>(
      '/api/openrouter/providers',
    );
    const map = new Map<string, string>();
    for (const item of data?.data || []) {
      if (item.slug && item.name) map.set(item.slug, item.name);
    }
    _providerNames = map;
    _providerNamesAt = Date.now();
    return map;
  } catch {
    return _providerNames ?? new Map();
  }
}

/**
 * Fetch /endpoints for a model.
 * Groups endpoints by base slug (tag.split('/')[0]) and resolves
 * display names via /api/openrouter/providers.
 */
async function fetchModelEndpoints(modelId: string): Promise<ModelEndpointsResult | null> {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx <= 0) return null;
  const author = encodeURIComponent(modelId.slice(0, slashIdx));
  const slug = encodeURIComponent(modelId.slice(slashIdx + 1));

  const [endpointsResp, providers] = await Promise.all([
    api<{ data?: { endpoints?: OrEndpoint[] } }>(
      `/api/openrouter/models/${author}/${slug}/endpoints`,
    ),
    loadProviderNames(),
  ]);

  const endpoints = endpointsResp?.data?.endpoints || [];

  // Group by base slug (tag.split('/')[0]).
  type Entry = {
    baseSlug: string;
    prices: ModelPrices;
    quantization?: string | null;
    contextLength?: number | null;
    uptime?: number | null;
  };
  const baseGroups = new Map<string, Entry[]>();
  for (const ep of endpoints) {
    const tag = ep.tag || '';
    const baseSlug = tag.split('/')[0];
    if (!baseSlug) continue;
    const prices = ep.pricing ? pricingToModelPrices(ep.pricing) : null;
    if (!prices) continue;
    const list = baseGroups.get(baseSlug) || [];
    list.push({
      baseSlug,
      prices,
      quantization: ep.quantization,
      contextLength: ep.context_length,
      uptime: ep.uptime_last_1d,
    });
    baseGroups.set(baseSlug, list);
  }

  const options: SelectOption[] = [];
  const pricesBySlug = new Map<string, ModelPrices | null>();
  let basePrices: ModelPrices | null = null;
  for (const [baseSlug, entries] of baseGroups) {
    const allPrices = entries.map((e) => e.prices);
    const minP = minModelPrices(allPrices);
    const maxP = maxModelPrices(allPrices);
    pricesBySlug.set(baseSlug, maxP);
    if (basePrices === null) basePrices = maxP;
    // Prices + quantizations + max context — joined for the option hint.
    const hintParts: string[] = [
      minP && maxP && entries.length > 1
        ? formatPricesRangeHint(minP, maxP)
        : formatPricesHint(maxP),
    ];
    const quants = [
      ...new Set(entries.map((e) => e.quantization).filter((q) => q && q !== 'unknown')),
    ] as string[];
    if (quants.length) hintParts.push(quants.sort().join('/'));
    const maxCtx = Math.max(...entries.map((e) => e.contextLength ?? 0));
    if (maxCtx > 0) hintParts.push(formatContextLength(maxCtx));
    // Uptime badge (last 24h, %): green ≥98, yellow ≥90, red below.
    const uptimes = entries.map((e) => e.uptime).filter((u): u is number => u != null);
    let badge: SelectBadge | undefined;
    if (uptimes.length) {
      const uptime = Math.min(...uptimes);
      badge = {
        text: `uptime ${Math.round(uptime)}%`,
        color: uptime >= 98 ? 'success' : uptime >= 90 ? 'warning' : 'error',
      };
    }
    const label = providers.get(baseSlug) || baseSlug;
    options.push({ value: baseSlug, label, hint: hintParts.join(' · '), badge });
  }
  // Cheapest output price first (nulls last) — manual provider picking is
  // primarily price-driven.
  options.sort((a, b) => {
    const outA = pricesBySlug.get(a.value)?.outputPricePerMillion;
    const outB = pricesBySlug.get(b.value)?.outputPricePerMillion;
    if (outA == null && outB == null) return 0;
    if (outA == null) return 1;
    if (outB == null) return -1;
    return outA - outB;
  });
  return { options, pricesBySlug, basePrices };
}

// ── ProviderModelFields ──────────────────────────────────────────────────────

// ── Per-model provider monitor badge ────────────────────────────────────────

const MONITOR_STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  missing: 'Missing',
  check_failed: 'Check failed',
  model_missing: 'Model removed',
  unknown: '—',
};

function ProviderMonitorStatus({ uniqueId, slug }: { uniqueId?: string; slug: string }) {
  const { t } = useTranslation();
  const { status, checkModels } = useOpenRouterMonitorStatus();
  const [checking, setChecking] = useState(false);
  if (!uniqueId || !slug) return null;

  const state = status?.states.find((s) => s.model_id === uniqueId) || null;
  const strategy =
    status?.settings.action && status.settings.action !== 'notify' ? status.settings.action : null;

  const handleCheckNow = async () => {
    setChecking(true);
    try {
      await checkModels([uniqueId]);
    } catch {
      /* surfaced in the panel */
    } finally {
      setChecking(false);
    }
  };

  const lastChecked = state?.last_check_at
    ? new Date(state.last_check_at * 1000).toLocaleString()
    : null;

  return (
    <div className={styles.monitorInline}>
      <span
        className={`${styles.monitorBadge} ${styles[`monitor_${state?.status || 'unknown'}`] || ''}`}
      >
        {state
          ? MONITOR_STATUS_LABELS[state.status] || state.status
          : t('models.monitor.noData') || 'Not checked yet'}
      </span>
      {strategy && (
        <small style={{ color: 'var(--color-muted)' }}>
          {t('models.monitor.strategy') || 'Strategy'}: {strategy}
        </small>
      )}
      {lastChecked && (
        <small style={{ color: 'var(--color-muted)' }}>
          {t('models.monitor.lastChecked') || 'Last checked'}: {lastChecked}
        </small>
      )}
      <button
        type="button"
        className="buttonSecondary"
        disabled={checking}
        onClick={() => void handleCheckNow()}
      >
        {checking
          ? t('models.monitor.checking') || 'Checking…'
          : t('models.monitor.checkNow') || 'Check now'}
      </button>
    </div>
  );
}

export function ProviderModelFields({
  model,
  onChange,
  required = true,
  coefficientManager,
}: {
  model: ProviderModelConfig;
  onChange: (patch: Partial<ProviderModelConfig>) => void;
  required?: boolean;
  coefficientManager?: CoefficientManager;
}) {
  const { t } = useTranslation();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [selectedApiKeyId, setSelectedApiKeyId] = useState('');

  const loadApiKeys = useCallback(() => {
    api<ApiKey[]>('/api/api-keys')
      .then(setApiKeys)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadApiKeys();
    window.addEventListener(API_KEYS_CHANGED_EVENT, loadApiKeys);
    return () => window.removeEventListener(API_KEYS_CHANGED_EVENT, loadApiKeys);
  }, [loadApiKeys]);

  const override = coefficientManager?.getOverride?.(model.uniqueId);

  // Sync selectedApiKeyId from override on load
  useEffect(() => {
    if (override?.selectedApiKeyId && !selectedApiKeyId) {
      setSelectedApiKeyId(`key:${override.selectedApiKeyId}`);
    }
  }, [override?.selectedApiKeyId]);
  const providerKind: ProviderKind = override?.providerKind || resolveProviderKind(model.baseUrl);

  const providerKindOpts: SelectOption[] = [
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'xiaomi', label: 'Xiaomi' },
    { value: 'custom', label: t('models.billing.customProvider') || 'Custom' },
  ];

  const [prices, setPrices] = useState({
    input: override?.inputPricePerMillion ?? (null as number | null),
    output: override?.outputPricePerMillion ?? (null as number | null),
    cache: override?.cacheReadPricePerMillion ?? (null as number | null),
    orSlug: override?.openrouterProviderSlug ?? '',
  });
  const [pricesTouched, setPricesTouched] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Dynamic upstream provider options (built from the model's /endpoints).
  const [orProviderOptions, setOrProviderOptions] = useState<SelectOption[]>([
    { value: '', label: t('models.billing.autoRouting') || 'Auto', hint: 'auto-routing' },
  ]);
  // Cache of (tag → prices) and base prices, fetched once per model.
  const endpointsCacheRef = useRef<ModelEndpointsResult | null>(null);

  // Sync prices from override when data loads or model changes, unless user is editing.
  useEffect(() => {
    if (pricesTouched) return;
    const nextInput = override?.inputPricePerMillion ?? null;
    const nextOutput = override?.outputPricePerMillion ?? null;
    const nextCache = override?.cacheReadPricePerMillion ?? null;
    const nextSlug = override?.openrouterProviderSlug ?? '';
    setPrices((prev) => {
      if (
        prev.input === nextInput &&
        prev.output === nextOutput &&
        prev.cache === nextCache &&
        prev.orSlug === nextSlug
      ) {
        return prev;
      }
      return { input: nextInput, output: nextOutput, cache: nextCache, orSlug: nextSlug };
    });
  }, [override, pricesTouched]);

  const persistOverride = useCallback(
    async (patch: Partial<ModelOverrideData>) => {
      const id = model.uniqueId?.trim();
      if (!id || !coefficientManager?.saveOverride) return;
      await coefficientManager.saveOverride(id, patch);
    },
    [model.uniqueId, coefficientManager],
  );

  // Load endpoints for a model: refreshes the upstream provider dropdown
  // and the cached price map. Returns the result for synchronous use.
  const loadEndpoints = useCallback(
    async (modelId: string): Promise<ModelEndpointsResult | null> => {
      if (!modelId || !modelId.includes('/')) return null;
      const result = await fetchModelEndpoints(modelId);
      if (result) {
        endpointsCacheRef.current = result;
        const autoOpt = {
          value: '',
          label: t('models.billing.autoRouting') || 'Auto',
          hint: 'auto-routing',
        };
        setOrProviderOptions([autoOpt, ...result.options]);
      }
      return result;
    },
    [t],
  );

  const applyAutoPrices = useCallback(
    async (mp: ModelPrices | null, source: 'auto' | 'endpoint' | 'preset') => {
      const next = {
        input: mp?.inputPricePerMillion ?? null,
        output: mp?.outputPricePerMillion ?? null,
        cache: mp?.cacheReadPricePerMillion ?? null,
      };
      setPrices((p) => ({ ...p, ...next }));
      setPricesTouched(true);
      const sourceLabel =
        source === 'auto'
          ? providerKind === 'deepseek' || providerKind === 'xiaomi'
            ? 'preset'
            : 'openrouter_auto'
          : source === 'endpoint'
            ? 'openrouter_endpoint'
            : 'preset';
      await persistOverride({
        providerKind,
        openrouterProviderSlug: prices.orSlug || null,
        inputPricePerMillion: next.input,
        outputPricePerMillion: next.output,
        cacheReadPricePerMillion: next.cache,
        pricingMode: 'auto',
        pricingSource: sourceLabel,
      });
    },
    [persistOverride, providerKind, prices.orSlug],
  );

  const handleModelSelect = async (modelId: string, basePrices: ModelPrices | null) => {
    onChange({ model: modelId });
    if (providerKind === 'openrouter') {
      // Load endpoints for the new model (refreshes the provider dropdown).
      const endpoints = await loadEndpoints(modelId);
      // Reset the upstream provider selector to "Auto" (different model = different endpoints).
      setPrices((p) => ({ ...p, orSlug: '' }));
      await persistOverride({ providerKind, openrouterProviderSlug: null });
      // Apply base pricing (from /models or first endpoint).
      const mp = endpoints?.basePrices ?? basePrices;
      if (mp) await applyAutoPrices(mp, 'auto');
      return;
    }
    // For deepseek/xiaomi preset models — apply the preset prices directly.
    if ((providerKind === 'deepseek' || providerKind === 'xiaomi') && basePrices) {
      await applyAutoPrices(basePrices, 'auto');
    }
  };

  const saveManualPrices = async () => {
    await persistOverride({
      providerKind,
      openrouterProviderSlug: providerKind === 'openrouter' ? prices.orSlug || null : null,
      inputPricePerMillion: prices.input,
      outputPricePerMillion: prices.output,
      cacheReadPricePerMillion: prices.cache,
      pricingMode: 'manual',
      pricingSource: 'manual',
    });
  };

  const handleProviderKindChange = (kind: string) => {
    const k = (kind || undefined) as ProviderKind | undefined;
    if (k && k !== 'custom' && PROVIDER_URLS[k]) onChange({ baseUrl: PROVIDER_URLS[k] });
    const id = model.uniqueId?.trim();
    if (id && coefficientManager?.saveOverride)
      void coefficientManager.saveOverride(id, { providerKind: k ?? null });
  };

  const handleOrProviderChange = async (slug: string) => {
    setPricesTouched(true);
    setPrices((p) => ({ ...p, orSlug: slug }));
    await persistOverride({
      providerKind,
      openrouterProviderSlug: slug || null,
    });
    // Apply prices for the selected provider.
    if (!slug) {
      // Auto: use base prices.
      const base = endpointsCacheRef.current?.basePrices ?? null;
      await applyAutoPrices(base, 'auto');
      return;
    }
    const cached = endpointsCacheRef.current?.pricesBySlug.get(slug) ?? null;
    // If we somehow don't have endpoints cached, fetch them now.
    if (!endpointsCacheRef.current && model.model) {
      await loadEndpoints(model.model);
    }
    const mp = endpointsCacheRef.current?.pricesBySlug.get(slug) ?? cached;
    await applyAutoPrices(mp, 'endpoint');
  };

  const handleRefreshPrices = async () => {
    if (!model.model) return;
    setRefreshing(true);
    try {
      const endpoints = await loadEndpoints(model.model);
      if (!endpoints) return;
      if (prices.orSlug) {
        const mp = endpoints.pricesBySlug.get(prices.orSlug) ?? null;
        await applyAutoPrices(mp, 'endpoint');
      } else {
        await applyAutoPrices(endpoints.basePrices, 'auto');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handlePriceChange = (key: 'input' | 'output' | 'cache', raw: string) => {
    setPricesTouched(true);
    setPrices((p) => ({ ...p, [key]: parseUserPrice(raw) }));
  };

  const isCustom = providerKind === 'custom';
  const showModelAutocomplete = providerKind === 'openrouter';
  const presetModels =
    providerKind === 'deepseek'
      ? DEEPSEEK_PRESET_MODELS
      : providerKind === 'xiaomi'
        ? XIAOMI_PRESET_MODELS
        : null;
  const isPricingFromOpenRouter =
    override?.pricingSource === 'openrouter_auto' ||
    override?.pricingSource === 'openrouter_endpoint';
  const isPricingFromPreset = override?.pricingSource === 'preset';

  return (
    <div className={styles.fields}>
      {/* Row 1: provider selector + model name */}
      <div className={styles.twoColumns}>
        <FormField label={t('models.providerFields.providerKind') || 'Provider'}>
          <Select
            options={providerKindOpts}
            value={providerKind ?? ''}
            onChange={handleProviderKindChange}
            placeholder={t('common.notSet')}
          />
        </FormField>
        <FormField label={t('models.providerFields.modelName')}>
          {showModelAutocomplete ? (
            <OpenRouterModelInput
              value={model.model}
              onSelect={(id, mp) => void handleModelSelect(id, mp)}
            />
          ) : presetModels ? (
            <PresetModelInput
              value={model.model}
              presets={presetModels}
              onSelect={(id, mp) => void handleModelSelect(id, mp)}
            />
          ) : (
            <input
              value={model.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder="provider/model-name"
              required={required}
            />
          )}
        </FormField>
      </div>

      {/* Row 2: URL */}
      <FormField label={t('models.providerFields.baseUrl')}>
        <input
          type="url"
          value={model.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder={PROVIDER_URLS[providerKind ?? 'custom'] || 'https://…'}
          required={required}
          readOnly={!isCustom}
        />
      </FormField>

      <FormField
        label={t('models.providerFields.proxyUrl')}
        hint={t('models.providerFields.proxyUrlHint')}
      >
        <input
          value={model.proxyUrl ?? ''}
          onChange={(e) => onChange({ proxyUrl: e.target.value })}
          placeholder="socks5://host.docker.internal:1080"
        />
      </FormField>

      {/* Row 3: quota id */}
      <FormField
        label={t('models.providerFields.quotaId')}
        hint={t('models.providerFields.quotaIdHint')}
      >
        <input
          value={model.uniqueId ?? ''}
          onChange={(e) => onChange({ uniqueId: e.target.value })}
          placeholder={`auto-${
            (model.model || 'model')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '') || 'model'
          }`}
        />
      </FormField>

      {/* Coefficient */}
      {coefficientManager?.get && (
        <FormField
          label={t('models.providerFields.coefficient')}
          hint={t('models.providerFields.coefficientHint')}
        >
          <input
            type="number"
            min={0}
            step={0.1}
            value={coefficientManager.get?.(model.uniqueId) ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              const id = model.uniqueId?.trim();
              if (id && Number.isFinite(v) && v >= 0) coefficientManager.set?.(id, v);
            }}
            onBlur={(e) => {
              const v = Number(e.target.value);
              const c = Number.isFinite(v) && v >= 0 ? v : 1;
              const id = model.uniqueId?.trim();
              if (id) void coefficientManager.save?.(id, c);
            }}
          />
        </FormField>
      )}

      {/* Prices — only if override hook is available */}
      {coefficientManager?.getOverride && (
        <>
          <FormField
            label={t('models.providerFields.isFree')}
            hint={t('models.providerFields.isFreeHint')}
          >
            <Toggle
              checked={Boolean(override?.isFree)}
              onChange={(checked) => {
                void persistOverride({ isFree: checked });
              }}
              label={
                override?.isFree
                  ? t('models.providerFields.isFreeOn')
                  : t('models.providerFields.isFreeOff')
              }
            />
          </FormField>
          {providerKind === 'openrouter' && (
            <FormField
              label={t('models.billing.openrouterProvider') || 'OpenRouter provider'}
              hint={
                t('models.billing.openrouterProviderHint') ||
                '“Auto” lets OpenRouter choose the endpoint'
              }
            >
              <Select
                options={orProviderOptions}
                value={prices.orSlug}
                onChange={(v) => void handleOrProviderChange(v)}
                searchable
                placeholder={t('models.billing.autoRouting') || 'Auto'}
                valueFallbackLabel={prices.orSlug || undefined}
              />
              <ProviderMonitorStatus uniqueId={model.uniqueId} slug={prices.orSlug} />
            </FormField>
          )}

          <div className={styles.threeColumns}>
            <FormField
              label={t('models.billing.inputPrice') || 'Input $/1M'}
              hint={t('models.billing.priceHint') || '$ per 1M tokens'}
            >
              <input
                type="number"
                min={0}
                step="any"
                value={prices.input ?? ''}
                onChange={(e) => handlePriceChange('input', e.target.value)}
                placeholder="0.00"
                onBlur={() => void saveManualPrices()}
              />
            </FormField>
            <FormField
              label={t('models.billing.outputPrice') || 'Output $/1M'}
              hint={t('models.billing.priceHint') || '$ per 1M tokens'}
            >
              <input
                type="number"
                min={0}
                step="any"
                value={prices.output ?? ''}
                onChange={(e) => handlePriceChange('output', e.target.value)}
                placeholder="0.00"
                onBlur={() => void saveManualPrices()}
              />
            </FormField>
            <FormField
              label={t('models.billing.cacheReadPrice') || 'Cached $/1M'}
              hint={t('models.billing.cacheReadPriceHint') || 'Falls back to input price if empty'}
            >
              <input
                type="number"
                min={0}
                step="any"
                value={prices.cache ?? ''}
                onChange={(e) => handlePriceChange('cache', e.target.value)}
                placeholder="0.00"
                onBlur={() => void saveManualPrices()}
              />
            </FormField>
          </div>

          {/* Display tiers for the desktop model selector (admin-optional) */}
          <div className={styles.threeColumns}>
            <FormField
              label={t('models.billing.intelTier') || 'Intelligence tier'}
              hint={t('models.billing.intelTierHint') || 'Shown in the user model selector'}
            >
              <Select
                options={[
                  { value: '', label: t('models.billing.tierUnset') || 'Not set' },
                  { value: '1', label: t('models.billing.intelLow') || '■□□ Basic' },
                  { value: '2', label: t('models.billing.intelMid') || '■■□ Smart' },
                  { value: '3', label: t('models.billing.intelHigh') || '■■■ Genius' },
                ]}
                value={override?.intelTier ? String(override.intelTier) : ''}
                onChange={(v) => void persistOverride({ intelTier: v ? (Number(v) as 1 | 2 | 3) : null })}
              />
            </FormField>
            <FormField
              label={t('models.billing.priceTier') || 'Price tier'}
              hint={t('models.billing.priceTierHint') || 'Shown as $ / $$ / $$$'}
            >
              <Select
                options={[
                  { value: '', label: t('models.billing.tierUnset') || 'Not set' },
                  { value: '1', label: t('models.billing.priceLow') || 'Cheap' },
                  { value: '2', label: t('models.billing.priceMid') || 'Average' },
                  { value: '3', label: t('models.billing.priceHigh') || 'Expensive' },
                ]}
                value={override?.priceTier ? String(override.priceTier) : ''}
                onChange={(v) => void persistOverride({ priceTier: v ? (Number(v) as 1 | 2 | 3) : null })}
              />
            </FormField>
            <FormField
              label={t('models.billing.measuredSpeed') || 'Measured speed'}
              hint={
                override?.tpsSamples
                  ? `${override.avgTps ?? '—'} t/s · ${override.tpsSamples} samples`
                  : t('models.billing.measuredSpeedHint') || 'Collected automatically from real usage'
              }
            >
              <input
                value={override?.avgTps ? `${Math.round(override.avgTps)} t/s` : '—'}
                readOnly
              />
            </FormField>
          </div>

          <div className={styles.pricingMetaRow}>
            {(isPricingFromOpenRouter || isPricingFromPreset) && (
              <small style={{ color: 'var(--color-muted)' }}>
                {t('models.billing.pricingSource') || 'Source'}: {override?.pricingSource}
              </small>
            )}
            {providerKind === 'openrouter' && (
              <button
                type="button"
                className="buttonSecondary"
                disabled={refreshing || !model.model}
                onClick={() => void handleRefreshPrices()}
              >
                {refreshing
                  ? t('models.billing.refreshing') || 'Refreshing…'
                  : t('models.billing.refreshPrices') || 'Refresh prices'}
              </button>
            )}
          </div>
        </>
      )}

      {/* API key: select from saved keys or create new */}
      {(() => {
        const selectOptions: SelectOption[] = [
          ...apiKeys.map((k) => ({
            value: `key:${k.id}`,
            label: k.name,
            hint: k.key_prefix,
          })),
          { value: '__create__', label: t('security.apiKeyCreateNew') },
          ...(model.hasApiKey
            ? [{ value: '__existing__', label: t('security.apiKeyExistingKey') }]
            : []),
        ];

        const handleSelectChange = (value: string) => {
          if (value === '__create__') {
            setShowCreateKey(true);
          } else if (value === '__existing__') {
            setSelectedApiKeyId('');
            coefficientManager?.saveOverride?.(model.uniqueId || '', { selectedApiKeyId: null });
          } else if (value.startsWith('key:')) {
            const id = Number(value.slice(4));
            setSelectedApiKeyId(value);
            coefficientManager?.saveOverride?.(model.uniqueId || '', { selectedApiKeyId: id });
            api<ApiKeyValue>(`/api/api-keys/${id}`)
              .then((keyData) => {
                onChange({ apiKey: keyData.key });
              })
              .catch(() => {});
          }
        };

        const handleCreateKey = async () => {
          if (!newKeyName || !newKeyValue) return;
          try {
            await api('/api/api-keys', {
              method: 'POST',
              body: JSON.stringify({ name: newKeyName, key: newKeyValue }),
            });
            setNewKeyName('');
            setNewKeyValue('');
            setShowCreateKey(false);
            window.dispatchEvent(new Event(API_KEYS_CHANGED_EVENT));
          } catch {
            // error handled by api helper
          }
        };

        if (showCreateKey) {
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <FormField label={t('security.apiKeyName')}>
                <input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder={t('security.apiKeyNamePlaceholder')}
                />
              </FormField>
              <FormField label={t('security.apiKeyValue')}>
                <input
                  type="password"
                  value={newKeyValue}
                  onChange={(e) => setNewKeyValue(e.target.value)}
                  placeholder={t('security.apiKeyValuePlaceholder')}
                />
              </FormField>
              <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                <button type="button" onClick={handleCreateKey}>
                  {t('security.apiKeyCreate')}
                </button>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => setShowCreateKey(false)}
                >
                  {t('common.cancel') || 'Cancel'}
                </button>
              </div>
            </div>
          );
        }

        return (
          <FormField
            label={t('security.apiKeySelect')}
            state={<SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />}
          >
            <Select
              options={selectOptions}
              value={selectedApiKeyId || (model.hasApiKey ? '__existing__' : '')}
              onChange={handleSelectChange}
              placeholder={t('security.apiKeySelectPlaceholder')}
            />
          </FormField>
        );
      })()}
    </div>
  );
}
