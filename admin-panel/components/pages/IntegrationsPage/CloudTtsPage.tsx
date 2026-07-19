import type { FormEvent } from 'react';
import type { CloudTtsSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import styles from './IntegrationsPage.module.css';

export function CloudTtsPage({
  settings,
  onChange,
  saving,
  saveState,
  onBack,
  onSave,
}: {
  settings: CloudTtsSettings;
  onChange: (patch: Partial<CloudTtsSettings>) => void;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
}) {
  return (
    <IntegrationDetailPage
      title="Cloud TTS"
      description="Облачная озвучка и каталог голосов Cartesia."
      saving={saving}
      saveState={saveState}
      onBack={onBack}
      onSave={onSave}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Cartesia</h3>
          <p>Ключ хранится только на сервере и используется backend для получения голосов и генерации аудио.</p>
        </div>
        <div className={styles.fields}>
          <IntegrationSecretField
            label="Cartesia API-ключ"
            value={settings.apiKey}
            configured={settings.hasApiKey}
            onChange={(apiKey) => onChange({ apiKey })}
          />
          <FormField label="Модель">
            <input
              value={settings.model}
              onChange={(event) => onChange({ model: event.target.value })}
              placeholder="sonic-3.5"
              required
            />
          </FormField>
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
