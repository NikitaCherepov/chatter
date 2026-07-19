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
  return (
    <div className={styles.toolbar}>
      <div className={styles.filters}>
        <select
          value={service}
          onChange={(event) => onServiceChange(event.target.value as LogService)}
          aria-label="Сервис"
        >
          <option value="all">Все сервисы</option>
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
          aria-label="Количество строк"
        >
          <option value="100">100 строк</option>
          <option value="200">200 строк</option>
          <option value="500">500 строк</option>
          <option value="1000">1000 строк</option>
        </select>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Фильтр по тексту"
        />
      </div>
      <div className={styles.actions}>
        <span className={`${styles.connection} ${connected ? styles.connected : ''}`}>
          <i />
          {connected ? 'Live' : 'Подключаемся'}
        </span>
        <button type="button" className="buttonSecondary" onClick={() => onPausedChange(!paused)}>
          {paused ? 'Продолжить' : 'Пауза'}
        </button>
        <button type="button" className="buttonSecondary" onClick={onClear}>
          Очистить
        </button>
        <button type="button" className="buttonSecondary" onClick={onDownload}>
          Скачать
        </button>
      </div>
    </div>
  );
}
