import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminSection } from '../../AdminShell/AdminShell';
import type { Service, Settings } from '../../../lib/types';
import { api } from '../../../lib/api';
import { Icon } from '../../icons/icons';
import { Card } from '../../ui/Card/Card';
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
  const configured = [
    settings.hasAiApiKey,
    settings.hasTelegramToken,
    settings.hasVoiceToken,
  ].filter(Boolean).length;

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
          <div className={styles.checklist}>
            <SetupRow
              title={t('overview.setupRows.mainModel.title')}
              description={t('overview.setupRows.mainModel.description')}
              ready={settings.hasAiApiKey}
              onClick={() => onNavigate('models')}
            />
            <SetupRow
              title={t('overview.setupRows.telegram.title')}
              description={t('overview.setupRows.telegram.description')}
              ready={settings.telegramEnabled && settings.hasTelegramToken}
              onClick={() => onNavigate('services')}
            />
            <SetupRow
              title={t('overview.setupRows.notes.title')}
              description={t('overview.setupRows.notes.description')}
              ready={
                settings.notesEnabled && settings.hasTelegramToken && Boolean(settings.notesUrl)
              }
              onClick={() => onNavigate('services')}
            />
            <SetupRow
              title={t('overview.setupRows.voice.title')}
              description={t('overview.setupRows.voice.description')}
              ready={settings.voiceMode !== 'off' && settings.hasVoiceToken}
              onClick={() => onNavigate('services')}
            />
          </div>
        </Card>
        <Card title={t('overview.config.title')} description={t('overview.config.description')}>
          <div className={styles.summary}>
            <strong>{t('overview.config.keysSummary', { count: configured })}</strong>
            <div className={styles.progress}>
              <span style={{ width: `${(configured / 3) * 100}%` }} />
            </div>
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
        {ready ? '✓' : ''}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <Icon name="arrow" />
    </button>
  );
}
