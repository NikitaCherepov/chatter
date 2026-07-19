import type { FormEvent } from 'react';
import type { PineconeSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import styles from './IntegrationsPage.module.css';

export function PineconePage({
  settings,
  onChange,
  saving,
  saveState,
  onBack,
  onSave,
}: {
  settings: PineconeSettings;
  onChange: (patch: Partial<PineconeSettings>) => void;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
}) {
  return (
    <IntegrationDetailPage
      title="Pinecone"
      description="Векторная память Chatter. Pinecone хранит данные, а embedding-модель превращает текст в векторы."
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Pinecone</h3>
          <p>Создай индекс в Pinecone и укажи его имя вместе с API-ключом.</p>
        </div>
        <div className={styles.fields}>
          <IntegrationSecretField
            label="Pinecone API-ключ"
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
            required
          />
          <FormField label="Название индекса">
            <input
              value={settings.indexName}
              onChange={(event) => onChange({ indexName: event.target.value })}
              placeholder="bot-memory"
              required
            />
          </FormField>
        </div>
      </section>
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Embedding-модель</h3>
          <p>Отдельный OpenAI-совместимый API, который превращает текст в векторы для Pinecone.</p>
        </div>
        <div className={styles.fields}>
          <div className={styles.twoColumns}>
            <FormField label="Адрес API">
              <input
                type="url"
                value={settings.embeddingBaseUrl}
                onChange={(event) => onChange({ embeddingBaseUrl: event.target.value })}
                required
              />
            </FormField>
            <FormField label="Модель">
              <input
                value={settings.embeddingModel}
                onChange={(event) => onChange({ embeddingModel: event.target.value })}
                required
              />
            </FormField>
          </div>
          <IntegrationSecretField
            label="API-ключ embedding-провайдера"
            value={settings.embeddingApiKey}
            configured={settings.hasEmbeddingApiKey}
            onChange={(embeddingApiKey) => onChange({ embeddingApiKey })}
            required
          />
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
