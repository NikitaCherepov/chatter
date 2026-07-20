import type { FormEvent } from 'react';
import type { WebSearchSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import { useTranslation } from 'react-i18next';
import styles from './IntegrationsPage.module.css';

export function WebSearchPage({
  settings,
  onChange,
  saving,
  saveState,
  onBack,
  onSave,
}: {
  settings: WebSearchSettings;
  onChange: (patch: Partial<WebSearchSettings>) => void;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <IntegrationDetailPage
      title="Web Search"
      description={t('integrations.webSearch.pageDescription')}
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Tavily</h3>
          <p>{t('integrations.webSearch.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <FormField label={t('integrations.webSearch.apiUrlLabel')}>
            <input
              type="url"
              value={settings.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              required
            />
          </FormField>
          <IntegrationSecretField
            label={t('integrations.webSearch.apiKeyLabel')}
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
          />
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
