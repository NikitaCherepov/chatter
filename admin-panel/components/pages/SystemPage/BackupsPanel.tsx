import { useTranslation } from 'react-i18next';
import { Checkbox } from '../../ui/Checkbox/Checkbox';
import type { BackupInfo } from './types';
import { formatBytes } from './types';
import styles from './SystemPage.module.css';

export function BackupsPanel({ backups, creating, restoring, importing, importProgress, includeUploads, includeConfiguration, state, onIncludeUploadsChange, onIncludeConfigurationChange, onCreate, onImport, onRestore, onDelete }: {
  backups: BackupInfo[];
  creating: boolean;
  restoring: boolean;
  importing: boolean;
  importProgress: number | null;
  includeUploads: boolean;
  includeConfiguration: boolean;
  state: string;
  onIncludeUploadsChange: (value: boolean) => void;
  onIncludeConfigurationChange: (value: boolean) => void;
  onCreate: () => void;
  onImport: (file: File) => void;
  onRestore: (backup: BackupInfo) => void;
  onDelete: (backup: BackupInfo) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.backupContent}>
      <div className={styles.backupToolbar}>
        <div className={styles.mediaOption}>
          <Checkbox checked={includeUploads} onChange={onIncludeUploadsChange} />
          <span><strong>{t('system.backups.includeUploads')}</strong><small>{t('system.backups.includeUploadsHint')}</small></span>
        </div>
        <div className={styles.mediaOption}>
          <Checkbox checked={includeConfiguration} onChange={onIncludeConfigurationChange} />
          <span><strong>{t('system.backups.includeConfig')}</strong><small>{t('system.backups.includeConfigHint')}</small></span>
        </div>
        <div className={styles.primaryActions}>
          <label className={`buttonSecondary ${styles.importButton}`}><input type="file" accept=".db,.sqlite,.sqlite3,.tar.gz,.tgz" disabled={creating || restoring || importing} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />{importing ? (importProgress === 100 ? t('system.backups.verifying') : t('system.backups.importing', { percent: importProgress ?? 0 })) : t('system.backups.importButton')}</label>
          <button type="button" className="buttonPrimary" onClick={onCreate} disabled={creating || restoring || importing}>{creating ? t('system.backups.creating') : t('system.backups.createBackup')}</button>
        </div>
      </div>
      {state && <p className={styles.operationState}>{state}</p>}
      <div className={styles.backupTable}>
        <div className={styles.tableHeader}><span>{t('system.backups.tableHeaders.date')}</span><span>{t('system.backups.tableHeaders.content')}</span><span>{t('system.backups.tableHeaders.size')}</span><span>{t('system.backups.tableHeaders.version')}</span><span /></div>
        {backups.length === 0 ? <div className={styles.empty}>{t('system.backups.empty')}</div> : backups.map((backup) => (
          <div className={styles.tableRow} key={backup.name}>
            <span>{new Date(backup.createdAt).toLocaleString()}</span>
            <span>{[backup.includesUploads ? t('system.backups.dbAndFiles') : t('system.backups.db'), backup.includesConfiguration ? t('system.backups.configuration') : ''].filter(Boolean).join(' + ')}</span>
            <span>{formatBytes(backup.size)}</span><span>{backup.version}{backup.source === 'automatic' ? ` · ${t('system.backups.auto')}` : ''}</span>
            <span className={styles.rowActions}>
              <a className="buttonSecondary" href={`/api/backups/${encodeURIComponent(backup.name)}/download`}>{t('system.backups.download')}</a>
              <button type="button" className="buttonSecondary" onClick={() => onRestore(backup)} disabled={creating || restoring || importing}>{t('system.backups.restore')}</button>
              <button type="button" className="buttonSecondary" onClick={() => onDelete(backup)} disabled={creating || restoring || importing}>{t('system.backups.delete')}</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
