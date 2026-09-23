import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PineconeSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { Select } from '../../ui/Select/Select';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import { api } from '../../../lib/api';
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
  const [activeStorage, setActiveStorage] = useState<'pinecone' | 'sqlite'>('pinecone');
  const [selectedStorage, setSelectedStorage] = useState<'pinecone' | 'sqlite'>('pinecone');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationState, setMigrationState] = useState('');
  const [migrationOk, setMigrationOk] = useState(false);

  useEffect(() => {
    void api<{ storage: 'pinecone' | 'sqlite' }>('/api/vector-memory/settings')
      .then(result => { setActiveStorage(result.storage); setSelectedStorage(result.storage); })
      .catch(error => { setMigrationOk(false); setMigrationState(error instanceof Error ? error.message : String(error)); });
  }, []);

  const applyStorage = async () => {
    setMigrating(true);
    setMigrationState('');
    setMigrationOk(false);
    try {
      if (activeStorage === 'pinecone' && selectedStorage === 'sqlite') {
        const result = await api<{ copied_vectors: number; records: number }>('/api/vector-memory/migrate-to-sqlite', { method: 'POST' });
        setMigrationState(t('integrations.pinecone.storage.result', { vectors: result.copied_vectors, records: result.records }));
      } else {
        await api('/api/vector-memory/settings', { method: 'PUT', body: JSON.stringify({ storage: selectedStorage }) });
        setMigrationState(t('integrations.pinecone.storage.switched'));
      }
      setActiveStorage(selectedStorage);
      setMigrationOk(true);
      setConfirmOpen(false);
    } catch (error) {
      setMigrationOk(false);
      setMigrationState(error instanceof Error ? error.message : String(error));
    } finally {
      setMigrating(false);
    }
  };
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
          <h3>{t('integrations.pinecone.storage.title')}</h3>
          <p>{t('integrations.pinecone.storage.intro')}</p>
        </div>
        <div className={styles.fields}>
          <FormField label={t('integrations.pinecone.storage.label')}>
            <Select
              value={selectedStorage}
              onChange={value => setSelectedStorage(value as 'pinecone' | 'sqlite')}
              options={[
                { value: 'pinecone', label: 'Pinecone', hint: t('integrations.pinecone.storage.pineconeHint') },
                { value: 'sqlite', label: t('integrations.pinecone.storage.sqlite'), hint: t('integrations.pinecone.storage.sqliteHint') },
              ]}
            />
          </FormField>
          {selectedStorage !== activeStorage && (
            <button type="button" className={styles.checkButton} onClick={() => setConfirmOpen(true)}>
              {selectedStorage === 'sqlite' ? t('integrations.pinecone.storage.migrateAction') : t('integrations.pinecone.storage.switchAction')}
            </button>
          )}
          {migrationState && <div className={migrationOk ? styles.checkSuccess : styles.checkError}>{migrationState}</div>}
        </div>
      </section>
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
      {confirmOpen && (
        <ConfirmModal
          title={selectedStorage === 'sqlite' ? t('integrations.pinecone.storage.migrateTitle') : t('integrations.pinecone.storage.switchTitle')}
          onClose={() => { if (!migrating) setConfirmOpen(false); }}
          actions={[
            { label: t('integrations.pinecone.storage.cancel'), onClick: () => setConfirmOpen(false), disabled: migrating },
            { label: migrating ? t('integrations.pinecone.storage.migrating') : selectedStorage === 'sqlite' ? t('integrations.pinecone.storage.migrateAction') : t('integrations.pinecone.storage.switchAction'), onClick: applyStorage, variant: 'primary', disabled: migrating },
          ]}
        >
          {selectedStorage === 'sqlite' ? (
            <><p>{t('integrations.pinecone.storage.migrateText')}</p><p>{t('integrations.pinecone.storage.backupText')}</p></>
          ) : (
            <p>{t('integrations.pinecone.storage.switchText')}</p>
          )}
        </ConfirmModal>
      )}
    </IntegrationDetailPage>
  );
}
