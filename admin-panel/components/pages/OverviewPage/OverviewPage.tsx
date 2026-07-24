import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminSection } from '../../AdminShell/AdminShell';
import type { Service, Settings } from '../../../lib/types';
import { api } from '../../../lib/api';
import { Icon } from '../../icons/icons';
import { Card } from '../../ui/Card/Card';
import { UpdateStatusCard } from './UpdateStatusCard';
import styles from './OverviewPage.module.css';

const serviceNames: Record<string, string> = {
  backend: 'Backend',
  'telegram-bot': 'Telegram',
  'webapp-notes': 'Webapp Notes',
  voice: 'Voice',
};

export function OverviewPage({
  services,
  settings,
  onRefresh,
  onNavigate,
}: {
  services: Service[];
  settings: Settings;
  onRefresh: () => Promise<void>;
  onNavigate: (section: AdminSection) => void;
}) {
  const [busyService, setBusyService] = useState('');
  const [actionError, setActionError] = useState('');
  const { t } = useTranslation();
  const serviceMap = new Map(services.map((service) => [service.service, service]));

  async function controlService(service: string, action: 'start' | 'stop' | 'restart') {
    setBusyService(service);
    setActionError('');
    try {
      await api(`/api/services/${encodeURIComponent(service)}/${action}`, {
        method: 'POST',
        body: '{}',
      });
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyService('');
    }
  }

  // Readiness checks
  const aiModelsReady =
    settings.hasAiApiKey &&
    settings.proModels.length > 0 &&
    settings.liteModels.length > 0;
  const telegramReady = settings.telegramEnabled && settings.hasTelegramToken;
  const webSearchReady = settings.webSearch.hasApiKey;
  const webReaderReady = settings.webReader.hasToken;
  const pineconeReady = settings.pinecone.hasApiKey;
  const notesReady =
    settings.notesEnabled && settings.hasTelegramToken && Boolean(settings.notesUrl);

  const steps = [
    aiModelsReady,
    telegramReady,
    webSearchReady,
    webReaderReady,
    pineconeReady,
    notesReady,
  ];
  const readyCount = steps.filter(Boolean).length;
  const totalCount = steps.length;

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <div>
          <strong>{t('overview.componentStatus')}</strong>
          <span>{t('overview.updatesAfterApply')}</span>
        </div>
        <button type="button" className="buttonSecondary" onClick={() => void onRefresh()}>
          <Icon name="refresh" />
          {t('overview.refresh')}
        </button>
      </div>
      <div className={styles.statusGrid}>
        {Object.keys(serviceNames).map((name) => (
          <ServiceCard
            key={name}
            name={serviceNames[name]}
            service={serviceMap.get(name)}
            busy={busyService === name}
            onAction={(action) => void controlService(name, action)}
          />
        ))}
      </div>
      {actionError && <div className={styles.actionError}>{t('overview.actionError', { error: actionError })}</div>}
      <div className={styles.columns}>
        <Card
          title={t('overview.quickSetup.title')}
          description={t('overview.quickSetup.description')}
        >
          <div className={styles.setupProgressBar}>
            <div
              className={styles.setupProgressFill}
              style={{ width: `${totalCount > 0 ? (readyCount / totalCount) * 100 : 0}%` }}
            />
          </div>
          <p className={styles.setupProgressLabel}>
            {t('overview.stepsDone', { done: readyCount, total: totalCount })}
          </p>

          <div className={styles.checklist}>
            {/* Required */}
            <div className={styles.setupGroupLabel}>{t('overview.requiredGroup')}</div>
            <SetupRow
              title={t('overview.setupRows.mainModel.title')}
              description={t('overview.setupRows.mainModel.description')}
              ready={aiModelsReady}
              onClick={() => onNavigate('models')}
            />

            {/* Recommended */}
            <div className={styles.setupGroupLabel}>{t('overview.recommendedGroup')}</div>
            <SetupRow
              title={t('overview.setupRows.telegram.title')}
              description={t('overview.setupRows.telegram.description')}
              ready={telegramReady}
              onClick={() => onNavigate('services')}
            />

            {/* Optional */}
            <div className={styles.setupGroupLabel}>{t('overview.optionalGroup')}</div>
            <SetupRow
              title={t('overview.setupRows.webSearch.title')}
              description={t('overview.setupRows.webSearch.description')}
              ready={webSearchReady}
              onClick={() => onNavigate('integrations')}
            />
            <SetupRow
              title={t('overview.setupRows.webReader.title')}
              description={t('overview.setupRows.webReader.description')}
              ready={webReaderReady}
              onClick={() => onNavigate('integrations')}
            />
            <SetupRow
              title={t('overview.setupRows.pinecone.title')}
              description={t('overview.setupRows.pinecone.description')}
              ready={pineconeReady}
              onClick={() => onNavigate('integrations')}
            />
            <SetupRow
              title={t('overview.setupRows.notes.title')}
              description={t('overview.setupRows.notes.description')}
              ready={notesReady}
              onClick={() => onNavigate('services')}
            />
          </div>
        </Card>
        <Card title={t('overview.updateStatus.title')} description={t('overview.updateStatus.description')}>
          <div className={styles.summary}>
            <UpdateStatusCard />
          </div>
        </Card>
      </div>
    </div>
  );
}

function ServiceCard({
  name,
  service,
  busy,
  onAction,
}: {
  name: string;
  service?: Service;
  busy: boolean;
  onAction: (action: 'start' | 'stop' | 'restart') => void;
}) {
  const { t } = useTranslation();
  const running = service?.state === 'running';
  const healthy = running && (!service.health || service.health === 'healthy');
  return (
    <article className={styles.statusCard}>
      <div className={styles.statusHeading}>
        <strong>{name}</strong>
        <div className={styles.cardControls}>
          <span className={`${styles.dot} ${healthy ? styles.good : running ? styles.warning : styles.off}`} />
          <div className={styles.statusActions}>
            {running ? (
              <>
                <button type="button" disabled={busy} onClick={() => onAction('restart')} title={t('overview.serviceCard.restart', { name })} aria-label={t('overview.serviceCard.restart', { name })}>↻</button>
                <button type="button" disabled={busy} onClick={() => onAction('stop')} title={t('overview.serviceCard.stop', { name })} aria-label={t('overview.serviceCard.stop', { name })}>■</button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => onAction('start')} title={t('overview.serviceCard.start', { name })} aria-label={t('overview.serviceCard.start', { name })}>▶</button>
            )}
          </div>
        </div>
      </div>
      <p>{busy ? t('overview.serviceCard.running') : service?.health || service?.status || t('overview.serviceCard.notRunning')}</p>
    </article>
  );
}

function SetupRow({
  title,
  description,
  ready,
  onClick,
}: {
  title: string;
  description: string;
  ready: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.setupRow} onClick={onClick}>
      <span className={`${styles.check} ${ready ? styles.checkReady : ''}`}>
        {ready && (
          <svg viewBox="0 0 12 10" fill="none" aria-hidden="true">
            <path d="M1 5 4.25 8.25 11 1.5" />
          </svg>
        )}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <Icon name="arrow" />
    </button>
  );
}
