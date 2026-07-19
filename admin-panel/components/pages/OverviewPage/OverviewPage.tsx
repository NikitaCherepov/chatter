import type { AdminSection } from '../../AdminShell/AdminShell';
import type { Service, Settings } from '../../../lib/types';
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
  const serviceMap = new Map(services.map((service) => [service.service, service]));
  const configured = [
    settings.hasAiApiKey,
    settings.hasTelegramToken,
    settings.hasVoiceToken,
  ].filter(Boolean).length;

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
          <ServiceCard key={name} name={serviceNames[name]} service={serviceMap.get(name)} />
        ))}
      </div>
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
              description="Бот и приложение заметок"
              ready={settings.telegramEnabled && settings.hasTelegramToken}
              onClick={() => onNavigate('services')}
            />
            <SetupRow
              title="Голос"
              description="Локальный или внешний Voice API"
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

function ServiceCard({ name, service }: { name: string; service?: Service }) {
  const running = service?.state === 'running';
  const healthy = running && (!service.health || service.health === 'healthy');
  return (
    <article className={styles.statusCard}>
      <div className={styles.statusHeading}>
        <strong>{name}</strong>
        <span
          className={`${styles.dot} ${healthy ? styles.good : running ? styles.warning : styles.off}`}
        />
      </div>
      <p>{service?.health || service?.status || 'не запущен'}</p>
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
