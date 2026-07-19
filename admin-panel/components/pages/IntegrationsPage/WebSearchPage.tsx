import type { FormEvent } from 'react';
import type { WebSearchSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
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
  return (
    <IntegrationDetailPage
      title="Web Search"
      description="Поиск актуальной информации в интернете через Tavily."
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Tavily</h3>
          <p>Используется инструментом поиска. Дневные ограничения пользователей настраиваются отдельно.</p>
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
            label="Tavily API-ключ"
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
          />
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
