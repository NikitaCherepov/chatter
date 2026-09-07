import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebReaderSettings } from '../../../lib/types';
import { api } from '../../../lib/api';
import { FormField } from '../../ui/FormField/FormField';
import { Toggle } from '../../ui/Toggle/Toggle';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import styles from './IntegrationsPage.module.css';

type RuntimePatch = Partial<Pick<WebReaderSettings, 'enabled' | 'desktopEnabled' | 'browserlessEnabled'>>;
type ReaderProvider = 'desktop' | 'browserless';
type ReaderStat = {
  provider: ReaderProvider;
  attempts: number;
  successes: number;
  failures: number;
  emptyResponses: number;
  unavailableFailures: number;
  timeoutFailures: number;
  parsingFailures: number;
  httpFailures: number;
  otherFailures: number;
  charactersReturned: number;
  lastAttemptAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
};

const PROVIDERS: ReaderProvider[] = ['desktop', 'browserless'];
const emptyStat = (provider: ReaderProvider): ReaderStat => ({
  provider,
  attempts: 0,
  successes: 0,
  failures: 0,
  emptyResponses: 0,
  unavailableFailures: 0,
  timeoutFailures: 0,
  parsingFailures: 0,
  httpFailures: 0,
  otherFailures: 0,
  charactersReturned: 0,
  lastAttemptAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
});

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
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [stats, setStats] = useState<ReaderStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      const result = await api<{ providers: ReaderStat[] }>('/api/web-reader/stats');
      setStats(result.providers || []);
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { void loadStats(); }, [loadStats]);

  async function updateRuntime(patch: RuntimePatch) {
    const previous = {
      enabled: settings.enabled,
      desktopEnabled: settings.desktopEnabled,
      browserlessEnabled: settings.browserlessEnabled,
    };
    onChange(patch);
    setRuntimeSaving(true);
    setRuntimeError('');
    try {
      const saved = await api<RuntimePatch>('/api/web-reader/runtime', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      onChange(saved);
    } catch (error) {
      onChange(previous);
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeSaving(false);
    }
  }

  const providerStats = PROVIDERS.map(provider => stats.find(row => row.provider === provider) || emptyStat(provider));
  const formatTimestamp = (value: number | null) => value ? new Date(value).toLocaleString() : '—';

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
          <h3>{t('integrations.webReader.routingTitle')}</h3>
          <p>{t('integrations.webReader.routingIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Toggle
            checked={settings.enabled}
            onChange={(enabled) => void updateRuntime({ enabled })}
            label={runtimeSaving ? t('integrations.webReader.savingRuntime') : t('integrations.webReader.enabled')}
            disabled={runtimeSaving}
          />
          {runtimeError && <span className={styles.checkError}>{runtimeError}</span>}
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.webReader.providers.desktop')}</h3>
          <p>{t('integrations.webReader.desktopIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Toggle
            checked={settings.desktopEnabled}
            onChange={(desktopEnabled) => void updateRuntime({ desktopEnabled })}
            label={t('integrations.webReader.desktopEnabled')}
            disabled={runtimeSaving || !settings.enabled}
          />
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>Browserless</h3>
          <p>{t('integrations.webReader.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Toggle
            checked={settings.browserlessEnabled}
            onChange={(browserlessEnabled) => void updateRuntime({ browserlessEnabled })}
            label={t('integrations.webReader.browserlessEnabled')}
            disabled={runtimeSaving || !settings.enabled}
          />
          <FormField label={t('integrations.webReader.apiUrlLabel')}>
            <input
              type="url"
              value={settings.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              required={settings.browserlessEnabled}
            />
          </FormField>
          <IntegrationSecretField
            label={t('integrations.webReader.apiKeyLabel')}
            value={settings.token}
            configured={settings.hasToken}
            onChange={(token) => onChange({ token })}
            required={settings.browserlessEnabled}
          />
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.webReader.statsTitle')}</h3>
          <p>{t('integrations.webReader.statsIntro')}</p>
          <button type="button" className={styles.statsRefresh} onClick={() => void loadStats()} disabled={statsLoading}>
            {statsLoading ? t('integrations.webReader.statsLoading') : t('integrations.webReader.statsRefresh')}
          </button>
        </div>
        <div className={styles.fields}>
          <div className={styles.statsCards}>
            {providerStats.map(stat => (
              <div className={styles.statsCard} key={stat.provider} title={stat.lastFailureReason || undefined}>
                <strong>{t(`integrations.webReader.providers.${stat.provider}`)}</strong>
                <span>{t('integrations.webReader.statsAttempts')}: {stat.attempts}</span>
                <span>{t('integrations.webReader.statsSuccesses')}: {stat.successes}</span>
                <span>{t('integrations.webReader.statsFailures')}: {stat.failures}</span>
                <span>{t('integrations.webReader.statsEmpty')}: {stat.emptyResponses}</span>
                <span>{t('integrations.webReader.statsCharacters')}: {stat.charactersReturned.toLocaleString()}</span>
                <span>{t('integrations.webReader.statsLastAttempt')}: {formatTimestamp(stat.lastAttemptAt)}</span>
              </div>
            ))}
          </div>
          <div className={styles.statsTableWrap}>
            <table className={styles.statsTable}>
              <thead>
                <tr>
                  <th>{t('integrations.webReader.statsProvider')}</th>
                  <th>{t('integrations.webReader.statsUnavailable')}</th>
                  <th>{t('integrations.webReader.statsTimeout')}</th>
                  <th>{t('integrations.webReader.statsParsing')}</th>
                  <th>HTTP</th>
                  <th>{t('integrations.webReader.statsOther')}</th>
                  <th>{t('integrations.webReader.statsLastFailure')}</th>
                </tr>
              </thead>
              <tbody>
                {providerStats.map(stat => (
                  <tr key={stat.provider} title={stat.lastFailureReason || undefined}>
                    <td>{t(`integrations.webReader.providers.${stat.provider}`)}</td>
                    <td>{stat.unavailableFailures}</td>
                    <td>{stat.timeoutFailures}</td>
                    <td>{stat.parsingFailures}</td>
                    <td>{stat.httpFailures}</td>
                    <td>{stat.otherFailures}</td>
                    <td className={styles.statsFailure}>
                      {stat.lastFailureAt ? `${formatTimestamp(stat.lastFailureAt)} · ${stat.lastFailureReason || '—'}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {statsError && <span className={styles.checkError}>{statsError}</span>}
        </div>
      </section>
    </IntegrationDetailPage>
  );
}
