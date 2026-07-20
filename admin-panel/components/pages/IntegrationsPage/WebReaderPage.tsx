import type { FormEvent } from 'react';
import type { WebReaderSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import { useTranslation } from 'react-i18next';
import styles from './IntegrationsPage.module.css';

export function WebReaderPage({
  settings,
  onChange,
  saving,
  saveState,
  onBack,
  onSave,
}: {
  settings: WebReaderSettings;
  onChange: (patch: Partial<WebReaderSettings>) => void;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <IntegrationDetailPage
      title="Web Reader"
      description={t('integrations.webReader.pageDescription')}
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Browserless</h3>
          <p>{t('integrations.webReader.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <FormField label={t('integrations.webReader.apiUrlLabel')}>
            <input
              type="url"
              value={settings.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              required
            />
          </FormField>
          <IntegrationSecretField
            label={t('integrations.webReader.apiKeyLabel')}
            value={settings.token}
            configured={settings.hasToken}
            onChange={(token) => onChange({ token })}
          />
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
