import { useTranslation } from 'react-i18next';
import { Input } from '../../ui/Input/Input';
import { Select } from '../../ui/Select/Select';
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
        <Select
          value={service}
          onChange={(value) => onServiceChange(value as LogService)}
          aria-label={t('logs.serviceFilter')}
          searchable
          searchPlaceholder={t('ui.search')}
          emptyText={t('ui.nothingFound')}
          options={[
            { value: 'all', label: t('logs.allServices') },
            { value: 'backend', label: 'Backend' },
            { value: 'telegram', label: 'Telegram Bot' },
            { value: 'notes', label: 'Webapp Notes' },
            { value: 'voice', label: 'Voice' },
            { value: 'manager', label: 'Chatter Manager' },
            { value: 'admin', label: 'Admin Panel' },
          ]}
        />
        <Select
          value={String(tail)}
          onChange={(value) => onTailChange(Number(value))}
          aria-label={t('logs.lineCount')}
          options={[
            { value: '100', label: t('logs.linesTemplate', { count: 100 }) },
            { value: '200', label: t('logs.linesTemplate', { count: 200 }) },
            { value: '500', label: t('logs.linesTemplate', { count: 500 }) },
            { value: '1000', label: t('logs.linesTemplate', { count: 1000 }) },
          ]}
        />
        <Input
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
