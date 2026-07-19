import type { FormEvent } from 'react';
import type { ImageGenerationSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import styles from './IntegrationsPage.module.css';

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
  return (
    <IntegrationDetailPage
      title="Генерация изображений"
      description="OpenRouter и Grok Imagine создают изображения и обрабатывают прикреплённые референсы."
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
          <FormField label="Адрес API">
            <input
              type="url"
              value={settings.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              required
            />
          </FormField>
          <IntegrationSecretField
            label="OpenRouter API-ключ"
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
            required
          />
          <FormField label="Модель">
            <input
              value={settings.model}
              onChange={(event) => onChange({ model: event.target.value })}
              placeholder="x-ai/grok-imagine-image-quality"
              required
            />
          </FormField>
          <FormField
            label="Максимальное разрешение"
            hint="2K даёт максимум качества, но обычно стоит дороже"
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
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
