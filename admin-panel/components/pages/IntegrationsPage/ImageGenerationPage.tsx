import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ImageGenerationSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Select } from '../../ui/Select/Select';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import styles from './IntegrationsPage.module.css';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
  const supportsResolution = settings.supportedParameters.includes('resolution');
  const supportsQuality = settings.supportedParameters.includes('quality');

  async function checkModel() {
    setChecking(true);
    setCheckResult(null);
    setCheckError('');
    try {
      const result = await api<ModelCheck>('/api/image-model/check', {
        method: 'POST',
        body: JSON.stringify({ model: settings.model, apiKey: settings.apiKey }),
      });
      setCheckResult(result);
      const patch: Partial<ImageGenerationSettings> = {
        supportedParameters: result.supportedParameters,
      };
      const resolutions = result.parameters.resolution?.values?.map(String) || [];
      if (resolutions.length > 0 && !resolutions.includes(settings.maxResolution)) {
        patch.maxResolution = resolutions.includes('2K') ? '2K' : '1K';
      }
      const qualities = result.parameters.quality?.values?.map(String) || [];
      if (qualities.length > 0 && !qualities.includes(settings.quality)) patch.quality = 'auto';
      onChange(patch);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : t('integrations.imageGeneration.checkError'));
    } finally {
      setChecking(false);
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
          <FormField label={t('integrations.imageGeneration.apiUrlLabel')} hint={t('integrations.imageGeneration.apiUrlHint')}>
            <Input type="url" value={OPENROUTER_BASE_URL} readOnly />
          </FormField>
          <IntegrationSecretField
            label={t('integrations.imageGeneration.apiKeyLabel')}
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
            required
          />
          <FormField
            label={t('integrations.imageGeneration.modelLabel')}
            hint={t('integrations.imageGeneration.modelHint')}
            state={
              checkResult ? <span className={styles.checkSuccess}>{t('integrations.imageGeneration.modelAvailable')}</span> : undefined
            }
          >
            <div className={styles.inputWithAction}>
              <Input
                value={settings.model}
                onChange={(event) => {
                  onChange({ model: event.target.value, supportedParameters: [] });
                  setCheckResult(null);
                  setCheckError('');
                }}
                placeholder="x-ai/grok-imagine-image-quality"
                required
              />
              <button
                className={styles.checkButton}
                type="button"
                onClick={checkModel}
                disabled={checking || !settings.model.trim() || (!settings.apiKey && !settings.hasApiKey)}
              >
                {checking ? t('integrations.imageGeneration.checking') : t('integrations.imageGeneration.checkButton')}
              </button>
            </div>
            {checkResult && <span className={styles.checkDetails}>{describeCapability(checkResult, t)}</span>}
            {checkError && <span className={styles.checkError}>{checkError}</span>}
          </FormField>
          {supportsResolution && (
            <FormField
              label={t('integrations.imageGeneration.resolutionLabel')}
              hint={t('integrations.imageGeneration.resolutionHint')}
            >
              <Select
                value={settings.maxResolution}
                onChange={(value) =>
                  onChange({
                    maxResolution: value as ImageGenerationSettings['maxResolution'],
                  })
                }
                options={[
                  { value: '1K', label: '1K' },
                  { value: '2K', label: '2K' },
                ]}
              />
            </FormField>
          )}
          {supportsQuality && (
            <FormField label={t('integrations.imageGeneration.qualityLabel')} hint={t('integrations.imageGeneration.qualityHint')}>
              <Select
                value={settings.quality}
                onChange={(value) =>
                  onChange({ quality: value as ImageGenerationSettings['quality'] })
                }
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ]}
              />
            </FormField>
          )}
          {settings.supportedParameters.length === 0 && (
            <p className={styles.parametersHint}>{t('integrations.imageGeneration.parametersHint')}</p>
          )}
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
