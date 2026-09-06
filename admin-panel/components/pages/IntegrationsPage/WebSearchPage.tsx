import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { WebSearchSettings } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { Toggle } from '../../ui/Toggle/Toggle';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { IntegrationSecretField } from './IntegrationSecretField';
import styles from './IntegrationsPage.module.css';

type SearchEngine = keyof WebSearchSettings['engines'];
type RuntimePatch = Partial<Pick<WebSearchSettings, 'enabled' | 'searxngEnabled'>> & {
  engines?: Partial<WebSearchSettings['engines']>;
};
type SearchStat = {
  provider: 'desktop' | 'searxng' | 'tavily';
  engine: string;
  attempts: number;
  successes: number;
  failures: number;
  emptyResponses: number;
  captchaFailures: number;
  rateLimitFailures: number;
  parsingFailures: number;
  httpFailures: number;
  otherFailures: number;
  resultsReturned: number;
  lastAttemptAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
};
type SearchStats = { providers: SearchStat[]; engines: SearchStat[] };

const SEARCH_ENGINES: SearchEngine[] = ['google', 'brave', 'duckduckgo', 'startpage', 'wikipedia'];
const PROVIDERS: SearchStat['provider'][] = ['desktop', 'searxng', 'tavily'];

const emptyStat = (provider: SearchStat['provider'], engine = ''): SearchStat => ({
  provider,
  engine,
  attempts: 0,
  successes: 0,
  failures: 0,
  emptyResponses: 0,
  captchaFailures: 0,
  rateLimitFailures: 0,
  parsingFailures: 0,
  httpFailures: 0,
  otherFailures: 0,
  resultsReturned: 0,
  lastAttemptAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
});

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
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [stats, setStats] = useState<SearchStats>({ providers: [], engines: [] });
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      setStats(await api<SearchStats>('/api/web-search/stats'));
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { void loadStats(); }, [loadStats]);

  async function updateRuntime(patch: RuntimePatch) {
    const previous = settings;
    const { engines, ...scalarPatch } = patch;
    onChange({
      ...scalarPatch,
      ...(engines ? { engines: { ...settings.engines, ...engines } } : {}),
    });
    setRuntimeSaving(true);
    setRuntimeError('');
    try {
      const saved = await api<Pick<WebSearchSettings, 'enabled' | 'searxngEnabled' | 'engines'>>('/api/web-search/runtime', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      onChange(saved);
    } catch (error) {
      onChange({ enabled: previous.enabled, searxngEnabled: previous.searxngEnabled, engines: previous.engines });
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeSaving(false);
    }
  }

  const providerStats = PROVIDERS.map(provider => stats.providers.find(row => row.provider === provider) || emptyStat(provider));
  const engineStats = SEARCH_ENGINES.map(engine => stats.engines.find(row => row.engine === engine) || emptyStat('searxng', engine));
  const formatTimestamp = (value: number | null) => value ? new Date(value).toLocaleString() : '—';

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
          <h3>{t('integrations.webSearch.routingTitle')}</h3>
          <p>{t('integrations.webSearch.routingIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Toggle
            checked={settings.enabled}
            onChange={(enabled) => void updateRuntime({ enabled })}
            label={runtimeSaving ? t('integrations.webSearch.savingRuntime') : t('integrations.webSearch.enabled')}
            disabled={runtimeSaving}
          />
          {runtimeError && <span className={styles.checkError}>{runtimeError}</span>}
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>SearXNG</h3>
          <p>{t('integrations.webSearch.searxngIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Toggle
            checked={settings.searxngEnabled}
            onChange={(searxngEnabled) => void updateRuntime({ searxngEnabled })}
            label={t('integrations.webSearch.searxngEnabled')}
            disabled={runtimeSaving || !settings.enabled}
          />
          <div className={styles.engineGrid}>
            {SEARCH_ENGINES.map(engine => (
              <Toggle
                key={engine}
                checked={settings.engines[engine]}
                onChange={(enabled) => void updateRuntime({ engines: { [engine]: enabled } })}
                label={t(`integrations.webSearch.engines.${engine}`)}
                disabled={runtimeSaving || !settings.enabled || !settings.searxngEnabled}
              />
            ))}
          </div>
        </div>
      </section>

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

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.webSearch.statsTitle')}</h3>
          <p>{t('integrations.webSearch.statsIntro')}</p>
          <button type="button" className={styles.statsRefresh} onClick={() => void loadStats()} disabled={statsLoading}>
            {statsLoading ? t('integrations.webSearch.statsLoading') : t('integrations.webSearch.statsRefresh')}
          </button>
        </div>
        <div className={styles.fields}>
          <div className={styles.statsCards}>
            {providerStats.map(stat => (
              <div className={styles.statsCard} key={stat.provider}>
                <strong>{t(`integrations.webSearch.providers.${stat.provider}`)}</strong>
                <span>{t('integrations.webSearch.statsAttempts')}: {stat.attempts}</span>
                <span>{t('integrations.webSearch.statsSuccesses')}: {stat.successes}</span>
                <span>{t('integrations.webSearch.statsFailures')}: {stat.failures}</span>
                <span>{t('integrations.webSearch.statsEmpty')}: {stat.emptyResponses}</span>
                <span>{t('integrations.webSearch.statsResults')}: {stat.resultsReturned}</span>
                <span>{t('integrations.webSearch.statsLastAttempt')}: {formatTimestamp(stat.lastAttemptAt)}</span>
              </div>
            ))}
          </div>
          <div className={styles.statsTableWrap}>
            <table className={styles.statsTable}>
              <thead>
                <tr>
                  <th>{t('integrations.webSearch.statsEngine')}</th>
                  <th>{t('integrations.webSearch.statsAttempts')}</th>
                  <th>{t('integrations.webSearch.statsSuccesses')}</th>
                  <th>{t('integrations.webSearch.statsEmpty')}</th>
                  <th>CAPTCHA</th>
                  <th>Rate limit</th>
                  <th>Parsing</th>
                  <th>HTTP</th>
                  <th>{t('integrations.webSearch.statsOther')}</th>
                  <th>{t('integrations.webSearch.statsResults')}</th>
                  <th>{t('integrations.webSearch.statsLastFailure')}</th>
                </tr>
              </thead>
              <tbody>
                {engineStats.map(stat => (
                  <tr key={stat.engine} title={stat.lastFailureReason || undefined}>
                    <td>{t(`integrations.webSearch.engines.${stat.engine}`)}</td>
                    <td>{stat.attempts}</td>
                    <td>{stat.successes}</td>
                    <td>{stat.emptyResponses}</td>
                    <td>{stat.captchaFailures}</td>
                    <td>{stat.rateLimitFailures}</td>
                    <td>{stat.parsingFailures}</td>
                    <td>{stat.httpFailures}</td>
                    <td>{stat.otherFailures}</td>
                    <td>{stat.resultsReturned}</td>
                    <td className={styles.statsFailure} title={stat.lastFailureReason || undefined}>
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
