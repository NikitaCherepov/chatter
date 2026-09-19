import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ApiKey, ImageGenParamPolicy, ImageGenerationSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Select, type SelectOption } from '../../ui/Select/Select';
import { SecretState } from '../../ui/SecretState/SecretState';
import { Toggle } from '../../ui/Toggle/Toggle';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import styles from './IntegrationsPage.module.css';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_CLOUDFLARE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const QUALITY_VALUES = ['auto', 'low', 'medium', 'high'] as const;

/** Sentinel select value for a model id typed by hand. */
const CUSTOM_MODEL = '__custom__';

const PROVIDER_OPTIONS: SelectOption[] = [
  { value: 'openrouter', label: 'OpenRouter', hint: 'Unified Image API' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', hint: 'FLUX.2 [klein]' },
];

const OPENROUTER_MODEL_OPTIONS: SelectOption[] = [
  { value: 'x-ai/grok-imagine-image-quality', label: 'Grok Imagine', hint: 'x-ai/grok-imagine-image-quality' },
  { value: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image (Nano Banana)', hint: 'google/gemini-2.5-flash-image' },
  { value: 'openai/gpt-image-1', label: 'GPT Image 1', hint: 'openai/gpt-image-1' },
];

const CLOUDFLARE_MODEL_OPTIONS: SelectOption[] = [
  { value: '@cf/black-forest-labs/flux-2-klein-4b', label: 'FLUX.2 [klein] 4B', hint: '@cf/black-forest-labs/flux-2-klein-4b' },
  { value: '@cf/black-forest-labs/flux-2-klein-9b', label: 'FLUX.2 [klein] 9B', hint: '@cf/black-forest-labs/flux-2-klein-9b' },
];

type CapabilityDescriptor = {
  type?: string;
  values?: Array<string | number | boolean>;
  min?: number;
  max?: number;
};

type ModelCheck = {
  model: string;
  endpointCount: number;
  supportedParameters: string[];
  parameters: Record<string, CapabilityDescriptor>;
};

type OpenRouterSearchModel = {
  id?: string;
  name?: string;
  architecture?: {
    modality?: string | null;
    output_modalities?: string[] | null;
  } | null;
};

function describeCapability(result: ModelCheck, t: (key: string) => string) {
  const resolution = result.parameters.resolution?.values?.join(', ');
  const quality = result.parameters.quality?.values?.join(', ');
  const references = result.supportedParameters.includes('input_references');
  const details = [
    resolution ? `${t('integrations.imageGeneration.capabilityResolution')}: ${resolution}` : null,
    quality ? `${t('integrations.imageGeneration.capabilityQuality')}: ${quality}` : null,
    `${t('integrations.imageGeneration.capabilityReferences')}: ${references ? t('integrations.imageGeneration.capabilitySupported') : t('integrations.imageGeneration.capabilityNotClaimed')}`,
  ].filter(Boolean);

  return details.join(' · ');
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const toValues = (descriptor: CapabilityDescriptor | undefined): string[] => [
  ...new Set((descriptor?.values ?? []).map((value) => String(value).trim()).filter(Boolean)),
];

const pickDefault = (values: string[], current: string | undefined, preferred: string): string => {
  if (current && values.includes(current)) return current;
  if (values.includes(preferred)) return preferred;
  return values[0];
};

/** The bot does not choose these values: the admin selects one runtime default. */
function ParamPolicyEditor({
  label,
  hint,
  policy,
  onChange,
}: {
  label: string;
  hint?: string;
  policy: ImageGenParamPolicy;
  onChange: (policy: ImageGenParamPolicy) => void;
}) {
  return (
    <div className={styles.policyBlock}>
      <span className={styles.policyLabel}>{label}</span>
      <Select
        className={styles.defaultSelect}
        value={policy.default}
        onChange={(value) => onChange({ ...policy, default: value })}
        options={policy.allowed.map((value) => ({ value, label: capitalize(value) }))}
        aria-label={label}
      />
      {hint && <span className={styles.parametersHint}>{hint}</span>}
    </div>
  );
}

export function ImageGenerationPage({
  settings,
  onChange,
  saving,
  saveState,
  onBack,
  onSave,
}: {
  settings: ImageGenerationSettings;
  onChange: (patch: Partial<ImageGenerationSettings>) => void;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ModelCheck | null>(null);
  const [checkError, setCheckError] = useState('');
  const [toggleSaving, setToggleSaving] = useState(false);
  const [toggleError, setToggleError] = useState('');
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [openRouterModelOptions, setOpenRouterModelOptions] = useState<SelectOption[]>(OPENROUTER_MODEL_OPTIONS);
  const modelSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelMetadata = useRef<Map<string, OpenRouterSearchModel>>(new Map());

  const loadApiKeys = useCallback(() => {
    api<ApiKey[]>('/api/api-keys').then(setApiKeys).catch(() => setApiKeys([]));
  }, []);

  useEffect(() => {
    loadApiKeys();
    window.addEventListener('chatter:api-keys-changed', loadApiKeys);
    return () => window.removeEventListener('chatter:api-keys-changed', loadApiKeys);
  }, [loadApiKeys]);

  const isCloudflare = settings.provider === 'cloudflare';
  const modelId = isCloudflare ? settings.cloudflare.model.id : settings.openrouter.model.id;
  const modelName = isCloudflare ? settings.cloudflare.model.name : settings.openrouter.model.name;
  const discoveredModelOptions = isCloudflare ? CLOUDFLARE_MODEL_OPTIONS : openRouterModelOptions;
  const modelOptions = modelId && !discoveredModelOptions.some((option) => option.value === modelId)
    ? [{ value: modelId, label: modelName || modelId, hint: modelId }, ...discoveredModelOptions]
    : discoveredModelOptions;
  const isKnownModel = modelOptions.some((option) => option.value === modelId);
  const secretReady = isCloudflare
    ? settings.cloudflare.hasApiToken
    : settings.openrouter.hasApiKey;
  const checkReady = modelId.trim() !== '' && secretReady
    && (!isCloudflare || settings.cloudflare.accountId.trim() !== '');
  const orParams = settings.openrouter.model.params;
  const qualityPolicy = isCloudflare ? settings.cloudflare.model.params.quality : orParams.quality;
  const hasPolicies = isCloudflare ? Boolean(qualityPolicy) : Boolean(orParams.resolution || orParams.quality);

  const patchOpenRouter = (patch: Partial<ImageGenerationSettings['openrouter']>) =>
    onChange({ openrouter: { ...settings.openrouter, ...patch } });
  const patchCloudflare = (patch: Partial<ImageGenerationSettings['cloudflare']>) =>
    onChange({ cloudflare: { ...settings.cloudflare, ...patch } });
  const apiKeyOptions: SelectOption[] = apiKeys.map((key) => ({
    value: `key:${key.id}`,
    label: key.name,
    hint: key.key_prefix,
  }));

  const resetCheck = () => {
    setCheckResult(null);
    setCheckError('');
  };

  const searchOpenRouterModels = (query: string) => {
    if (modelSearchDebounce.current) clearTimeout(modelSearchDebounce.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOpenRouterModelOptions(OPENROUTER_MODEL_OPTIONS);
      return;
    }
    modelSearchDebounce.current = setTimeout(async () => {
      try {
        const result = await api<{ data?: OpenRouterSearchModel[] }>(
          `/api/openrouter/image-models?q=${encodeURIComponent(trimmed)}`,
        );
        const discovered = (result.data ?? [])
          .filter((entry) => {
            const outputs = entry.architecture?.output_modalities ?? [];
            const modality = `${entry.architecture?.modality ?? ''}`.toLowerCase();
            const identity = `${entry.id ?? ''} ${entry.name ?? ''}`.toLowerCase();
            return outputs.includes('image')
              || modality.includes('image')
              || /(?:image|flux|grok-imagine)/.test(identity);
          })
          .map((entry) => {
            if (entry.id) modelMetadata.current.set(entry.id, entry);
            return {
              value: `${entry.id ?? ''}`,
              label: `${entry.name || entry.id || ''}`,
              hint: `${entry.id ?? ''}`,
            };
          })
          .filter((entry) => entry.value);
        const merged = new Map(OPENROUTER_MODEL_OPTIONS.map((entry) => [entry.value, entry]));
        for (const entry of discovered) merged.set(entry.value, entry);
        setOpenRouterModelOptions([...merged.values()]);
      } catch {
        setOpenRouterModelOptions(OPENROUTER_MODEL_OPTIONS);
      }
    }, 400);
  };

  // Switching the model resets parameter policies: the allowlist belongs to
  // the concrete model and is re-discovered via the check button.
  const applyModelId = (id: string, name = id, capabilities: unknown = null) => {
    resetCheck();
    if (isCloudflare) {
      patchCloudflare({
        model: { id, name, capabilities, params: { quality: { allowed: [...QUALITY_VALUES], default: 'auto' } } },
      });
    } else {
      patchOpenRouter({ model: { id, name, capabilities, params: { resolution: null, quality: null } } });
    }
  };

  async function checkModel() {
    setChecking(true);
    setCheckResult(null);
    setCheckError('');
    try {
      const result = await api<ModelCheck>('/api/image-model/check', {
        method: 'POST',
        body: JSON.stringify(
          isCloudflare
            ? {
              provider: 'cloudflare',
              model: settings.cloudflare.model.id,
              apiKey: settings.cloudflare.apiToken,
              accountId: settings.cloudflare.accountId,
            }
            : {
              provider: 'openrouter',
              model: settings.openrouter.model.id,
              apiKey: settings.openrouter.apiKey,
              baseUrl: settings.openrouter.baseUrl,
            },
        ),
      });
      setCheckResult(result);

      // Detected values become the available admin presets; the bot receives
      // only the selected default at runtime.
      const resolutions = toValues(result.parameters.resolution);
      const qualities = toValues(result.parameters.quality);
      if (isCloudflare) {
        patchCloudflare({
          model: {
            ...settings.cloudflare.model,
            capabilities: result,
            params: {
              quality: qualities.length > 0
                ? {
                  allowed: qualities,
                  default: pickDefault(qualities, qualityPolicy?.default, 'auto'),
                }
                : qualityPolicy,
            },
          },
        });
      } else {
        patchOpenRouter({
          model: {
            ...settings.openrouter.model,
            capabilities: result,
            params: {
              resolution: resolutions.length > 0
                ? {
                  allowed: resolutions,
                  default: pickDefault(
                    resolutions,
                    orParams.resolution?.default,
                    resolutions.includes('2K') ? '2K' : resolutions[0],
                  ),
                }
                : null,
              quality: qualities.length > 0
                ? {
                  allowed: qualities,
                  default: pickDefault(qualities, orParams.quality?.default, 'auto'),
                }
                : null,
            },
          },
        });
      }
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : t('integrations.imageGeneration.checkError'));
    } finally {
      setChecking(false);
    }
  }

  async function toggleEnabled(enabled: boolean) {
    const previous = settings.enabled;
    onChange({ enabled });
    setToggleSaving(true);
    setToggleError('');
    try {
      const saved = await api<{ enabled: boolean }>('/api/image-generation/settings', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      onChange({ enabled: saved.enabled });
    } catch (error) {
      onChange({ enabled: previous });
      setToggleError(error instanceof Error ? error.message : String(error));
    } finally {
      setToggleSaving(false);
    }
  }

  return (
    <IntegrationDetailPage
      title={t('integrations.imageGeneration.pageTitle')}
      description={t('integrations.imageGeneration.pageDescription')}
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.imageGeneration.sectionTitle')}</h3>
          <p>{t('integrations.imageGeneration.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Toggle
            checked={settings.enabled}
            onChange={(enabled) => void toggleEnabled(enabled)}
            label={toggleSaving
              ? t('integrations.imageGeneration.savingEnabled')
              : t('integrations.imageGeneration.enabled')}
            disabled={toggleSaving}
          />
          {toggleError && <span className={styles.checkError}>{toggleError}</span>}
          <FormField label={t('integrations.imageGeneration.providerLabel')} hint={t('integrations.imageGeneration.providerHint')}>
            <Select
              value={settings.provider}
              onChange={(value) => {
                resetCheck();
                onChange({ provider: value as ImageGenerationSettings['provider'] });
              }}
              options={PROVIDER_OPTIONS}
              aria-label={t('integrations.imageGeneration.providerLabel')}
            />
          </FormField>
          {isCloudflare ? (
            <>
              <FormField
                label={t('integrations.imageGeneration.apiTokenLabel')}
                state={<SecretState configured={settings.cloudflare.hasApiToken} />}
              >
                <Select
                  options={apiKeyOptions}
                  value={settings.cloudflare.apiTokenId ? `key:${settings.cloudflare.apiTokenId}` : ''}
                  onChange={(value) => patchCloudflare({
                    apiTokenId: value.startsWith('key:') ? Number(value.slice(4)) : null,
                    apiToken: '',
                  })}
                  placeholder={t('security.apiKeySelectPlaceholder')}
                />
              </FormField>
              <FormField
                label={t('integrations.imageGeneration.accountIdLabel')}
                hint={t('integrations.imageGeneration.accountIdHint')}
              >
                <Input
                  value={settings.cloudflare.accountId}
                  onChange={(event) => patchCloudflare({ accountId: event.target.value })}
                  placeholder="1234abcd…"
                  autoComplete="off"
                  required={settings.enabled}
                />
              </FormField>
            </>
          ) : (
            <>
              <FormField label={t('integrations.imageGeneration.apiUrlLabel')} hint={t('integrations.imageGeneration.apiUrlHint')}>
                <Input type="url" value={settings.openrouter.baseUrl || OPENROUTER_BASE_URL} readOnly />
              </FormField>
              <FormField
                label={t('integrations.imageGeneration.apiKeyLabel')}
                state={<SecretState configured={settings.openrouter.hasApiKey} />}
              >
                <Select
                  options={apiKeyOptions}
                  value={settings.openrouter.apiKeyId ? `key:${settings.openrouter.apiKeyId}` : ''}
                  onChange={(value) => patchOpenRouter({
                    apiKeyId: value.startsWith('key:') ? Number(value.slice(4)) : null,
                    apiKey: '',
                  })}
                  placeholder={t('security.apiKeySelectPlaceholder')}
                />
              </FormField>
            </>
          )}
          <FormField
            label={t('integrations.imageGeneration.modelLabel')}
            hint={t('integrations.imageGeneration.modelHint')}
            state={
              checkResult ? <span className={styles.checkSuccess}>{t('integrations.imageGeneration.modelAvailable')}</span> : undefined
            }
          >
            <div className={styles.inputWithAction}>
              <Select
                value={isKnownModel ? modelId : CUSTOM_MODEL}
                onChange={(value) => {
                  if (value === CUSTOM_MODEL) {
                    // Already-custom ids stay as they are so the input below
                    // remains editable in place; preset ids are cleared.
                    if (isKnownModel) applyModelId('');
                  } else {
                    const option = modelOptions.find((item) => item.value === value);
                    applyModelId(value, option?.label || value, modelMetadata.current.get(value) ?? null);
                  }
                }}
                options={[...modelOptions, { value: CUSTOM_MODEL, label: t('integrations.imageGeneration.customModelLabel') }]}
                searchable={!isCloudflare}
                onSearchChange={isCloudflare ? undefined : searchOpenRouterModels}
                searchPlaceholder={t('models.billing.searchModelHint') || 'Type 2+ chars'}
                emptyText={t('models.billing.noModelsFound') || 'No models found'}
                valueFallbackLabel={modelName || modelId || undefined}
                aria-label={t('integrations.imageGeneration.modelLabel')}
              />
              <button
                className={styles.checkButton}
                type="button"
                onClick={checkModel}
                disabled={checking || !checkReady}
              >
                {checking ? t('integrations.imageGeneration.checking') : t('integrations.imageGeneration.checkButton')}
              </button>
            </div>
            {!isKnownModel && (
              <Input
                className={styles.customModelInput}
                value={modelId}
                onChange={(event) => applyModelId(event.target.value)}
                placeholder={isCloudflare ? DEFAULT_CLOUDFLARE_MODEL : 'vendor/model'}
                required={settings.enabled}
              />
            )}
            {checkResult && <span className={styles.checkDetails}>{describeCapability(checkResult, t)}</span>}
            {checkError && <span className={styles.checkError}>{checkError}</span>}
          </FormField>
          {!isCloudflare && orParams.resolution && (
            <ParamPolicyEditor
              label={t('integrations.imageGeneration.resolutionLabel')}
              hint={t('integrations.imageGeneration.resolutionHint')}
              policy={orParams.resolution}
              onChange={(resolution) =>
                patchOpenRouter({ model: { ...settings.openrouter.model, params: { ...orParams, resolution } } })}
            />
          )}
          {qualityPolicy && (
            <ParamPolicyEditor
              label={t('integrations.imageGeneration.qualityLabel')}
              hint={t('integrations.imageGeneration.qualityHint')}
              policy={qualityPolicy}
              onChange={(quality) => isCloudflare
                ? patchCloudflare({
                  model: {
                    ...settings.cloudflare.model,
                    params: { quality },
                  },
                })
                : patchOpenRouter({
                  model: { ...settings.openrouter.model, params: { ...orParams, quality } },
                })}
            />
          )}
          <Toggle
            checked={settings.img2imgEnabled}
            onChange={(img2imgEnabled) => onChange({ img2imgEnabled })}
            label={t('integrations.imageGeneration.img2imgLabel')}
          />
          <span className={styles.parametersHint}>{t('integrations.imageGeneration.img2imgHint')}</span>
          {!hasPolicies && (
            <p className={styles.parametersHint}>{t('integrations.imageGeneration.parametersHint')}</p>
          )}
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
