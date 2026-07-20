import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <IntegrationDetailPage
      title="Pinecone"
      description={t('integrations.pinecone.pageDescription')}
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.pinecone.sectionTitle')}</h3>
          <p>{t('integrations.pinecone.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <IntegrationSecretField
            label={t('integrations.pinecone.apiKeyLabel')}
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
            required
          />
          <FormField label={t('integrations.pinecone.indexNameLabel')}>
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
          <h3>{t('integrations.pinecone.embedding.sectionTitle')}</h3>
          <p>{t('integrations.pinecone.embedding.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <div className={styles.twoColumns}>
            <FormField label={t('integrations.pinecone.embedding.apiUrlLabel')}>
              <input
                type="url"
                value={settings.embeddingBaseUrl}
                onChange={(event) => onChange({ embeddingBaseUrl: event.target.value })}
                required
              />
            </FormField>
            <FormField label={t('integrations.pinecone.embedding.modelLabel')}>
              <input
                value={settings.embeddingModel}
                onChange={(event) => onChange({ embeddingModel: event.target.value })}
                required
              />
            </FormField>
          </div>
          <IntegrationSecretField
            label={t('integrations.pinecone.embedding.apiKeyLabel')}
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
