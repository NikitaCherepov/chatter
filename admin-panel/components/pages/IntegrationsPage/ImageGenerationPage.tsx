import { useState, type FormEvent } from 'react';
import { api } from '../../../lib/api';
import type { ImageGenerationSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
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

function describeCapability(result: ModelCheck) {
  const resolution = result.parameters.resolution?.values?.join(', ');
  const quality = result.parameters.quality?.values?.join(', ');
  const references = result.supportedParameters.includes('input_references');
  const details = [
    resolution ? `разрешение: ${resolution}` : null,
    quality ? `качество: ${quality}` : null,
    `референсы: ${references ? 'поддерживаются' : 'не заявлены'}`,
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
      setCheckError(error instanceof Error ? error.message : 'Не удалось проверить модель');
    } finally {
      setChecking(false);
    }
  }

  return (
    <IntegrationDetailPage
      title="Генерация изображений"
      description="Пока поддерживается только OpenRouter. Модели GPT Image, Nano Banana и Grok подключаются через его единый Image API."
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>OpenRouter</h3>
          <p>Отдельный ключ используется только для генерации изображений и хранится на сервере.</p>
        </div>
        <div className={styles.fields}>
          <FormField label="Адрес API" hint="Другие провайдеры пока не поддерживаются">
            <input type="url" value={OPENROUTER_BASE_URL} readOnly />
          </FormField>
          <IntegrationSecretField
            label="OpenRouter API-ключ"
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
            required
          />
          <FormField
            label="Модель"
            hint="Укажи OpenRouter slug модели и проверь доступные параметры"
            state={
              checkResult ? <span className={styles.checkSuccess}>доступна</span> : undefined
            }
          >
            <div className={styles.inputWithAction}>
              <input
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
                {checking ? 'Проверяем…' : 'Проверить'}
              </button>
            </div>
            {checkResult && <span className={styles.checkDetails}>{describeCapability(checkResult)}</span>}
            {checkError && <span className={styles.checkError}>{checkError}</span>}
          </FormField>
          {supportsResolution && (
            <FormField
              label="Максимальное разрешение"
              hint="Параметр поддерживается выбранной моделью"
            >
              <select
                value={settings.maxResolution}
                onChange={(event) =>
                  onChange({
                    maxResolution: event.target.value as ImageGenerationSettings['maxResolution'],
                  })
                }
              >
                <option value="1K">1K</option>
                <option value="2K">2K</option>
              </select>
            </FormField>
          )}
          {supportsQuality && (
            <FormField label="Качество" hint="Чем выше качество, тем дороже генерация">
              <select
                value={settings.quality}
                onChange={(event) =>
                  onChange({ quality: event.target.value as ImageGenerationSettings['quality'] })
                }
              >
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </FormField>
          )}
          {settings.supportedParameters.length === 0 && (
            <p className={styles.parametersHint}>Проверь модель, чтобы настроить поддерживаемые параметры.</p>
          )}
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
