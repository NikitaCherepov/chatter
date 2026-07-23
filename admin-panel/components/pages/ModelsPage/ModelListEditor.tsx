import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelOverrideData, ProviderKind, ProviderModelConfig } from '../../../lib/types';
import {
  DEEPSEEK_PRESET_MODELS,
  XIAOMI_PRESET_MODELS,
  formatPricesHint,
  type ModelPrices,
} from '../../../lib/presetModels';
import { api } from '../../../lib/api';
import { Select, type SelectOption } from '../../ui/Select/Select';
import {
  OpenRouterModelInput,
  PresetModelInput,
  pricingToModelPrices,
  parseUserPrice,
  type OpenRouterPricing,
} from '../../ui/ModelInput';
import { FormField } from '../../ui/FormField/FormField';
import { SecretState } from '../../ui/SecretState/SecretState';
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
};

const newModel = (): ProviderModelConfig => ({
  id: `new-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  baseUrl: '',
  model: '',
  apiKey: '',
  hasApiKey: false,
});

export function ModelListEditor({
  title, description, models, onChange, required = false, emptyText, coefficientManager,
}: Props) {
  const { t } = useTranslation();
  const update = (index: number, patch: Partial<ProviderModelConfig>) => {
    onChange(models.map((model, i) => i === index ? { ...model, ...patch } : model));
  };
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= models.length) return;
    const next = [...models];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className={styles.modelList}>
      {(title || description) && (
        <div className={styles.listHeading}>
          <div>{title && <h3>{title}</h3>}{description && <p>{description}</p>}</div>
        </div>
      )}
      {!models.length && <p className={styles.empty}>{emptyText || t('models.common.emptyText')}</p>}
      {models.map((model, index) => (
        <div className={styles.modelSequence} key={model.id}>
          {index > 0 && <span className={styles.nextLabel}>{t('models.common.nextModel')}</span>}
          <details className={styles.modelCard} open={index === 0 ? true : undefined}>
            <summary>
              <span className={styles.order}>{index + 1}</span>
              <span className={styles.modelTitle}>
                <strong>{model.model || t('models.common.newModel')}</strong>
                <span>{model.baseUrl || t('models.common.providerNotSet')}</span>
              </span>
              <SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />
            </summary>
            <div className={styles.modelBody}>
              <ProviderModelFields model={model} onChange={p => update(index, p)} coefficientManager={coefficientManager} />
              <div className={styles.modelActions}>
                <button className="buttonSecondary" type="button" disabled={index === 0} onClick={() => move(index, -1)}>{t('models.common.moveUp')}</button>
                <button className="buttonSecondary" type="button" disabled={index === models.length - 1} onClick={() => move(index, 1)}>{t('models.common.moveDown')}</button>
                <button className={styles.dangerButton} type="button" disabled={required && models.length === 1} onClick={() => onChange(models.filter((_, i) => i !== index))}>{t('models.common.remove')}</button>
              </div>
            </div>
          </details>
        </div>
      ))}
      <button className="buttonSecondary" type="button" onClick={() => onChange([...models, newModel()])}>{t('models.common.addModel')}</button>
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

function resolveProviderKind(baseUrl: string): ProviderKind {
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
};

type ModelEndpointsResult = {
  /** SelectOption list for the upstream provider dropdown.
   *  Always starts with "Auto" (empty value). */
  options: SelectOption[];
  /** Map of tag → prices for instant lookup when the user picks a provider. */
  pricesByTag: Map<string, ModelPrices | null>;
  /** Base model price (first endpoint), used for Auto routing. */
  basePrices: ModelPrices | null;
};

/**
 * Fetch /endpoints for a model and build:
 *   - the list of available upstream providers (dynamic per model),
 *   - a price map for each tag,
 *   - a base price (first endpoint) for Auto routing.
 */
async function fetchModelEndpoints(modelId: string): Promise<ModelEndpointsResult | null> {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx <= 0) return null;
  const author = encodeURIComponent(modelId.slice(0, slashIdx));
  const slug = encodeURIComponent(modelId.slice(slashIdx + 1));
  try {
    const data = await api<{ data?: { endpoints?: OrEndpoint[] } }>(
      `/api/openrouter/models/${author}/${slug}/endpoints`
    );
    const endpoints = data?.data?.endpoints || [];
    const options: SelectOption[] = [];
    const pricesByTag = new Map<string, ModelPrices | null>();
    let basePrices: ModelPrices | null = null;
    for (const ep of endpoints) {
      const tag = ep.tag || '';
      if (!tag) continue;
      const label = ep.provider_name || ep.name || tag;
      const prices = ep.pricing ? pricingToModelPrices(ep.pricing) : null;
      pricesByTag.set(tag, prices);
      if (basePrices === null) basePrices = prices;
      options.push({ value: tag, label, hint: formatPricesHint(prices) });
    }
    return { options, pricesByTag, basePrices };
  } catch {
    return null;
  }
}

// ── ProviderModelFields ──────────────────────────────────────────────────────

export function ProviderModelFields({
  model, onChange, required = true, coefficientManager,
}: {
  model: ProviderModelConfig;
  onChange: (patch: Partial<ProviderModelConfig>) => void;
  required?: boolean;
  coefficientManager?: CoefficientManager;
}) {
  const { t } = useTranslation();
  const override = coefficientManager?.getOverride?.(model.uniqueId);
  const providerKind: ProviderKind = override?.providerKind || resolveProviderKind(model.baseUrl);

  const providerKindOpts: SelectOption[] = [
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'xiaomi', label: 'Xiaomi' },
    { value: 'custom', label: t('models.billing.customProvider') || 'Custom' },
  ];

  const [prices, setPrices] = useState({
    input: override?.inputPricePerMillion ?? null as number | null,
    output: override?.outputPricePerMillion ?? null as number | null,
    cache: override?.cacheReadPricePerMillion ?? null as number | null,
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

  const lastSyncedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (pricesTouched) return;
    const id = model.uniqueId ?? null;
    if (lastSyncedIdRef.current === id) return;
    lastSyncedIdRef.current = id;
    const o = coefficientManager?.getOverride?.(id);
    if (o) {
      setPrices({
        input: o.inputPricePerMillion ?? null,
        output: o.outputPricePerMillion ?? null,
        cache: o.cacheReadPricePerMillion ?? null,
        orSlug: o.openrouterProviderSlug ?? '',
      });
    } else {
      setPrices({ input: null, output: null, cache: null, orSlug: '' });
    }
  }, [model.uniqueId, pricesTouched, coefficientManager]);

  const persistOverride = useCallback(async (patch: Partial<ModelOverrideData>) => {
    const id = model.uniqueId?.trim();
    if (!id || !coefficientManager?.saveOverride) return;
    await coefficientManager.saveOverride(id, patch);
  }, [model.uniqueId, coefficientManager]);

  // Load endpoints for a model: refreshes the upstream provider dropdown
  // and the cached price map. Returns the result for synchronous use.
  const loadEndpoints = useCallback(async (modelId: string): Promise<ModelEndpointsResult | null> => {
    if (!modelId || !modelId.includes('/')) return null;
    const result = await fetchModelEndpoints(modelId);
    if (result) {
      endpointsCacheRef.current = result;
      const autoOpt = { value: '', label: t('models.billing.autoRouting') || 'Auto', hint: 'auto-routing' };
      setOrProviderOptions([autoOpt, ...result.options]);
    }
    return result;
  }, [t]);

  const applyAutoPrices = useCallback(async (mp: ModelPrices | null, source: 'auto' | 'endpoint' | 'preset') => {
    const next = {
      input: mp?.inputPricePerMillion ?? null,
      output: mp?.outputPricePerMillion ?? null,
      cache: mp?.cacheReadPricePerMillion ?? null,
    };
    setPrices((p) => ({ ...p, ...next }));
    setPricesTouched(true);
    const sourceLabel = source === 'auto'
      ? (providerKind === 'deepseek' || providerKind === 'xiaomi' ? 'preset' : 'openrouter_auto')
      : source === 'endpoint' ? 'openrouter_endpoint'
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
  }, [persistOverride, providerKind, prices.orSlug]);

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
      openrouterProviderSlug: providerKind === 'openrouter' ? (prices.orSlug || null) : null,
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
    if (id && coefficientManager?.saveOverride) void coefficientManager.saveOverride(id, { providerKind: k ?? null });
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
    const cached = endpointsCacheRef.current?.pricesByTag.get(slug) ?? null;
    // If we somehow don't have endpoints cached, fetch them now.
    if (!endpointsCacheRef.current && model.model) {
      await loadEndpoints(model.model);
    }
    const mp = endpointsCacheRef.current?.pricesByTag.get(slug) ?? cached;
    await applyAutoPrices(mp, 'endpoint');
  };

  const handleRefreshPrices = async () => {
    if (!model.model) return;
    setRefreshing(true);
    try {
      const endpoints = await loadEndpoints(model.model);
      if (!endpoints) return;
      if (prices.orSlug) {
        const mp = endpoints.pricesByTag.get(prices.orSlug) ?? null;
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
  const presetModels = providerKind === 'deepseek' ? DEEPSEEK_PRESET_MODELS
    : providerKind === 'xiaomi' ? XIAOMI_PRESET_MODELS
    : null;
  const isPricingFromOpenRouter = override?.pricingSource === 'openrouter_auto'
    || override?.pricingSource === 'openrouter_endpoint';
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
            <input value={model.model} onChange={e => onChange({ model: e.target.value })}
              placeholder="provider/model-name" required={required} />
          )}
        </FormField>
      </div>

      {/* Row 2: URL */}
      <FormField label={t('models.providerFields.baseUrl')}>
        <input type="url" value={model.baseUrl}
          onChange={e => onChange({ baseUrl: e.target.value })}
          placeholder={PROVIDER_URLS[providerKind ?? 'custom'] || 'https://…'} required={required} readOnly={!isCustom} />
      </FormField>

      {/* Row 3: quota id */}
      <FormField label={t('models.providerFields.quotaId')} hint={t('models.providerFields.quotaIdHint')}>
        <input value={model.uniqueId ?? ''} onChange={e => onChange({ uniqueId: e.target.value })}
          placeholder={`auto-${(model.model || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`} />
      </FormField>

      {/* Coefficient */}
      {coefficientManager?.get && (
        <FormField label={t('models.providerFields.coefficient')} hint={t('models.providerFields.coefficientHint')}>
          <input type="number" min={0} step={0.1} value={coefficientManager.get?.(model.uniqueId) ?? 1}
            onChange={e => { const v = Number(e.target.value); const id = model.uniqueId?.trim(); if (id && Number.isFinite(v) && v >= 0) coefficientManager.set?.(id, v); }}
            onBlur={e => { const v = Number(e.target.value); const c = Number.isFinite(v) && v >= 0 ? v : 1; const id = model.uniqueId?.trim(); if (id) void coefficientManager.save?.(id, c); }} />
        </FormField>
      )}

      {/* Prices — only if override hook is available */}
      {coefficientManager?.getOverride && (
        <>
          {providerKind === 'openrouter' && (
            <FormField label={t('models.billing.openrouterProvider') || 'OpenRouter provider'}
              hint={t('models.billing.openrouterProviderHint') || '“Auto” lets OpenRouter choose the endpoint'}>
              <Select
                options={orProviderOptions}
                value={prices.orSlug}
                onChange={(v) => void handleOrProviderChange(v)}
                searchable
                placeholder={t('models.billing.autoRouting') || 'Auto'}
                valueFallbackLabel={prices.orSlug || undefined}
              />
            </FormField>
          )}

          <div className={styles.threeColumns}>
            <FormField label={t('models.billing.inputPrice') || 'Input $/1M'}
              hint={t('models.billing.priceHint') || '$ per 1M tokens'}>
              <input type="number" min={0} step="any" value={prices.input ?? ''}
                onChange={e => handlePriceChange('input', e.target.value)}
                placeholder="0.00" onBlur={() => void saveManualPrices()} />
            </FormField>
            <FormField label={t('models.billing.outputPrice') || 'Output $/1M'}
              hint={t('models.billing.priceHint') || '$ per 1M tokens'}>
              <input type="number" min={0} step="any" value={prices.output ?? ''}
                onChange={e => handlePriceChange('output', e.target.value)}
                placeholder="0.00" onBlur={() => void saveManualPrices()} />
            </FormField>
            <FormField label={t('models.billing.cacheReadPrice') || 'Cached $/1M'}
              hint={t('models.billing.cacheReadPriceHint') || 'Falls back to input price if empty'}>
              <input type="number" min={0} step="any" value={prices.cache ?? ''}
                onChange={e => handlePriceChange('cache', e.target.value)}
                placeholder="0.00" onBlur={() => void saveManualPrices()} />
            </FormField>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
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
                  ? (t('models.billing.refreshing') || 'Refreshing…')
                  : (t('models.billing.refreshPrices') || 'Refresh prices')}
              </button>
            )}
          </div>
        </>
      )}

      {/* API key last */}
      <FormField label={t('models.providerFields.apiKey')}
        state={<SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />}
        hint={model.hasApiKey ? t('models.providerFields.apiKeyHint') : undefined}>
        <input type="password" value={model.apiKey} onChange={e => onChange({ apiKey: e.target.value })} autoComplete="off"
          placeholder={model.hasApiKey ? t('models.providerFields.apiKeyPlaceholderExisting') : t('models.providerFields.apiKeyPlaceholderNew')}
          required={required && !model.hasApiKey} />
      </FormField>
    </div>
  );
}
