import { useTranslation } from 'react-i18next';
import styles from './LogsPage.module.css';

export type LogService = 'all' | 'backend' | 'telegram' | 'notes' | 'voice' | 'manager' | 'admin';

export function LogToolbar({
  service,
  tail,
  paused,
  connected,
  search,
  onServiceChange,
  onTailChange,
  onPausedChange,
  onSearchChange,
  onClear,
  onDownload,
}: {
  service: LogService;
  tail: number;
  paused: boolean;
  connected: boolean;
  search: string;
  onServiceChange: (service: LogService) => void;
  onTailChange: (tail: number) => void;
  onPausedChange: (paused: boolean) => void;
  onSearchChange: (search: string) => void;
  onClear: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.toolbar}>
      <div className={styles.filters}>
        <select
          value={service}
          onChange={(event) => onServiceChange(event.target.value as LogService)}
          aria-label={t('logs.serviceFilter')}
        >
          <option value="all">{t('logs.allServices')}</option>
          <option value="backend">Backend</option>
          <option value="telegram">Telegram Bot</option>
          <option value="notes">Webapp Notes</option>
          <option value="voice">Voice</option>
          <option value="manager">Chatter Manager</option>
          <option value="admin">Admin Panel</option>
        </select>
        <select
          value={tail}
          onChange={(event) => onTailChange(Number(event.target.value))}
          aria-label={t('logs.lineCount')}
        >
          <option value="100">{t('logs.linesTemplate', { count: 100 })}</option>
          <option value="200">{t('logs.linesTemplate', { count: 200 })}</option>
          <option value="500">{t('logs.linesTemplate', { count: 500 })}</option>
          <option value="1000">{t('logs.linesTemplate', { count: 1000 })}</option>
        </select>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t('logs.textFilter')}
        />
      </div>
      <div className={styles.actions}>
        <span className={`${styles.connection} ${connected ? styles.connected : ''}`}>
          <i />
          {connected ? t('logs.live') : t('logs.connecting')}
        </span>
        <button type="button" className="buttonSecondary" onClick={() => onPausedChange(!paused)}>
          {paused ? t('logs.resume') : t('logs.pause')}
        </button>
        <button type="button" className="buttonSecondary" onClick={onClear}>
          {t('logs.clear')}
        </button>
        <button type="button" className="buttonSecondary" onClick={onDownload}>
          {t('logs.download')}
        </button>
      </div>
    </div>
  );
}
