'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '../../ui/Card/Card';
import { BackupsPanel } from '../SystemPage/BackupsPanel';
import { BackupSchedulePanel } from '../SystemPage/BackupSchedulePanel';
import type { BackupInfo, BackupSchedule } from '../SystemPage/types';
import { formatBytes } from '../SystemPage/types';
import { useBackups, useBackupSchedule } from '../../../lib/hooks/useBackups';
import { useBackupMutations } from '../../../lib/hooks/useBackupMutations';
import { useBackupDetails } from '../../../lib/hooks/useBackupDetails';
import { uploadBackup } from '../../../lib/services/backupService';
import { useBackendRestartDrain } from '../../../lib/hooks/useBackendRestartDrain';
import { ServerUpdateModal } from '../SystemPage/ServerUpdateModal/ServerUpdateModal';
import styles from '../SystemPage/SystemPage.module.css';

export function BackupsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const backupsQuery = useBackups();
  const scheduleQuery = useBackupSchedule();
  const { createMutation, deleteMutation, restoreMutation, scheduleMutation, message, scheduleMessage } = useBackupMutations(t);

  const [includeUploads, setIncludeUploads] = useState(false);
  const [includeConfiguration, setIncludeConfiguration] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [importState, setImportState] = useState('');
  const [schedule, setSchedule] = useState<BackupSchedule>({ frequency: 'off', includeUploads: false, retention: 10, lastRunAt: '' });
  const pendingRestoreRef = useRef<string | null>(null);

  const restoreRestart = useBackendRestartDrain({
    apply: applyPendingRestore,
    closeOnSuccess: true,
  });

  async function applyPendingRestore() {
    const backupName = pendingRestoreRef.current;
    if (!backupName) throw new Error('backup_restore_missing');
    await restoreMutation.mutateAsync(backupName);
    pendingRestoreRef.current = null;
  }

  // Sync schedule from query to local state for editing
  useEffect(() => {
    if (scheduleQuery.data) setSchedule(scheduleQuery.data);
  }, [scheduleQuery.data]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['backups'] });
  }, [queryClient]);

  function handleCreate() {
    createMutation.mutate({ includeUploads, includeConfiguration });
  }

  function handleDelete(backup: BackupInfo) {
    if (!window.confirm(t('system.backups.deleteConfirm', { name: backup.name }))) return;
    deleteMutation.mutate(backup.name);
  }

  function handleRestore(backup: BackupInfo) {
    if (!window.confirm(t('system.backups.restoreConfirm', { name: backup.name }))) return;
    pendingRestoreRef.current = backup.name;
    void restoreRestart.show();
  }

  async function handleImport(file: File) {
    setImporting(true);
    setImportProgress(0);
    setImportState(t('system.backups.uploading', { name: file.name, percent: 0, loaded: formatBytes(0), total: formatBytes(file.size) }));
    try {
      await uploadBackup(file, (loaded, total) => {
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        setImportProgress(percent);
        setImportState(t('system.backups.uploading', { name: file.name, percent, loaded: formatBytes(loaded), total: formatBytes(total) }));
      }, () => setImportState(t('system.backups.uploaded')));
      await queryClient.invalidateQueries({ queryKey: ['backups'], exact: true });
      setImportState(t('system.backups.imported'));
    } catch (error) {
      setImportState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }

  // ─── Lazy-load manifest details for each backup ────────────────────────────
  const baseBackups = backupsQuery.data?.backups ?? [];
  const { map: detailsMap } = useBackupDetails(baseBackups.map((b) => b.name));

  // ─── Derived state ───────────────────────────────────────────────────────
  const loading = backupsQuery.isLoading || scheduleQuery.isLoading;
  const backups = baseBackups.map((b) => ({ ...b, ...detailsMap.get(b.name) }));
  const creating = createMutation.isPending || (backupsQuery.data?.creating ?? false);
  const restoring = restoreMutation.isPending || (backupsQuery.data?.restoring ?? false);
  const scheduleSaving = scheduleMutation.isPending;
  const busy = creating || restoring || importing || deleteMutation.isPending;
  const displayState = importState || message || (backupsQuery.error ? t('system.error', { message: backupsQuery.error instanceof Error ? backupsQuery.error.message : String(backupsQuery.error) }) : '');

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <span>{loading ? t('system.updating') : t('system.dataFrom')}</span>
        <button type="button" className="buttonSecondary" onClick={handleRefresh} disabled={loading || busy}>
          {t('system.refresh')}
        </button>
      </div>
      <Card title={t('system.schedule.title')} description={t('system.schedule.description')}>
        <BackupSchedulePanel
          schedule={schedule}
          saving={scheduleSaving}
          state={scheduleMessage}
          onChange={(patch) => { setSchedule((current) => ({ ...current, ...patch })); }}
          onSave={() => scheduleMutation.mutate(schedule)}
        />
      </Card>
      <Card title={t('system.backups.title')} description={t('system.backups.description')}>
        <BackupsPanel
          backups={backups}
          creating={creating}
          restoring={restoring}
          importing={importing}
          importProgress={importProgress}
          includeUploads={includeUploads}
          includeConfiguration={includeConfiguration}
          state={displayState}
          onIncludeUploadsChange={setIncludeUploads}
          onIncludeConfigurationChange={setIncludeConfiguration}
          onCreate={handleCreate}
          onImport={(file) => void handleImport(file)}
          onRestore={(backup) => handleRestore(backup)}
          onDelete={(backup) => handleDelete(backup)}
        />
      </Card>
      {restoreRestart.open && (
        <ServerUpdateModal
          mode="configuration"
          changelog={{}}
          rebuiltFromSameCommit={false}
          updating={restoreRestart.phase === 'applying'}
          operationStatus="idle"
          operationMessage=""
          drainPhase={restoreRestart.phase}
          drain={restoreRestart.drain}
          applyError={restoreRestart.error}
          onCancel={restoreRestart.cancel}
          onRetry={restoreRestart.retry}
          onSoftUpdate={restoreRestart.soft}
          onForceUpdate={restoreRestart.force}
        />
      )}
    </div>
  );
}
