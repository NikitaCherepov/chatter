import type { FormEvent } from 'react';
import type { WebReaderSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
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
  return (
    <IntegrationDetailPage
      title="Web Reader"
      description="Открытие и очистка содержимого веб-страниц через Browserless."
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Browserless</h3>
          <p>Backend использует Browserless BQL, чтобы открыть страницу и извлечь её текст.</p>
        </div>
        <div className={styles.fields}>
          <FormField label="Адрес Browserless">
            <input
              type="url"
              value={settings.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              required
            />
          </FormField>
          <IntegrationSecretField
            label="Browserless token"
            value={settings.token}
            configured={settings.hasToken}
            onChange={(token) => onChange({ token })}
            placeholder="Вставь токен Browserless"
          />
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
