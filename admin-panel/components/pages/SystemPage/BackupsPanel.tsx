import type { BackupInfo } from './types';
import { formatBytes } from './types';
import styles from './SystemPage.module.css';

export function BackupsPanel({ backups, creating, restoring, importing, includeUploads, state, onIncludeUploadsChange, onCreate, onImport, onRestore, onDelete }: {
  backups: BackupInfo[];
  creating: boolean;
  restoring: boolean;
  importing: boolean;
  includeUploads: boolean;
  state: string;
  onIncludeUploadsChange: (value: boolean) => void;
  onCreate: () => void;
  onImport: (file: File) => void;
  onRestore: (backup: BackupInfo) => void;
  onDelete: (backup: BackupInfo) => void;
}) {
  return (
    <div className={styles.backupContent}>
      <div className={styles.backupToolbar}>
        <label className={styles.mediaOption}>
          <input type="checkbox" checked={includeUploads} onChange={(event) => onIncludeUploadsChange(event.target.checked)} />
          <span><strong>Включить загруженные файлы</strong><small>Фотографии, документы и аудио могут значительно увеличить архив</small></span>
        </label>
        <div className={styles.primaryActions}>
          <label className={`buttonSecondary ${styles.importButton}`}><input type="file" accept=".db,.sqlite,.sqlite3,.tar.gz,.tgz" disabled={creating || restoring || importing} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />{importing ? 'Импортируем…' : 'Импортировать'}</label>
          <button type="button" className="buttonPrimary" onClick={onCreate} disabled={creating || restoring || importing}>{creating ? 'Создаём…' : 'Создать бэкап'}</button>
        </div>
      </div>
      {state && <p className={styles.operationState}>{state}</p>}
      <div className={styles.backupTable}>
        <div className={styles.tableHeader}><span>Дата</span><span>Содержимое</span><span>Размер</span><span>Версия</span><span /></div>
        {backups.length === 0 ? <div className={styles.empty}>Резервных копий пока нет.</div> : backups.map((backup) => (
          <div className={styles.tableRow} key={backup.name}>
            <span>{new Date(backup.createdAt).toLocaleString()}</span>
            <span>{backup.includesUploads ? 'БД + файлы' : 'Только БД'}</span>
            <span>{formatBytes(backup.size)}</span><span>{backup.version}{backup.source === 'automatic' ? ' · авто' : ''}</span>
            <span className={styles.rowActions}>
              <a className="buttonSecondary" href={`/api/backups/${encodeURIComponent(backup.name)}/download`}>Скачать</a>
              <button type="button" className="buttonSecondary" onClick={() => onRestore(backup)} disabled={creating || restoring || importing}>Восстановить</button>
              <button type="button" className="buttonSecondary" onClick={() => onDelete(backup)} disabled={creating || restoring || importing}>Удалить</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
