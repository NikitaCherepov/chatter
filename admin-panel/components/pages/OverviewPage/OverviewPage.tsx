import { useState } from 'react';
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
          <strong>Состояние компонентов</strong>
          <span>Обновляется после применения настроек</span>
        </div>
        <button type="button" className="buttonSecondary" onClick={() => void onRefresh()}>
          <Icon name="refresh" />
          Обновить
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
      {actionError && <div className={styles.actionError}>Не удалось выполнить действие: {actionError}</div>}
      <div className={styles.columns}>
        <Card
          title="Быстрая настройка"
          description="Основные части, необходимые для полноценной работы"
        >
          <div className={styles.checklist}>
            <SetupRow
              title="Основная модель"
              description="OpenAI-совместимый провайдер"
              ready={settings.hasAiApiKey}
              onClick={() => onNavigate('models')}
            />
            <SetupRow
              title="Telegram"
              description="Основной Telegram-бот"
              ready={settings.telegramEnabled && settings.hasTelegramToken}
              onClick={() => onNavigate('services')}
            />
            <SetupRow
              title="Webapp Notes"
              description="Необязательное Telegram Mini App"
              ready={
                settings.notesEnabled && settings.hasTelegramToken && Boolean(settings.notesUrl)
              }
              onClick={() => onNavigate('services')}
            />
            <SetupRow
              title="Голос"
              description="Распознавание и озвучка для Telegram"
              ready={settings.voiceMode !== 'off' && settings.hasVoiceToken}
              onClick={() => onNavigate('services')}
            />
          </div>
        </Card>
        <Card title="Конфигурация" description="Текущее состояние подключений">
          <div className={styles.summary}>
            <strong>{configured} из 3</strong>
            <span>основных ключей сохранено</span>
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
                <button type="button" disabled={busy} onClick={() => onAction('restart')} title={`Перезапустить ${name}`} aria-label={`Перезапустить ${name}`}>↻</button>
                <button type="button" disabled={busy} onClick={() => onAction('stop')} title={`Остановить ${name}`} aria-label={`Остановить ${name}`}>■</button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => onAction('start')} title={`Запустить ${name}`} aria-label={`Запустить ${name}`}>▶</button>
            )}
          </div>
        </div>
      </div>
      <p>{busy ? 'выполняется…' : service?.health || service?.status || 'не запущен'}</p>
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
