'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { BackupsPanel } from '../SystemPage/BackupsPanel';
import { BackupSchedulePanel } from '../SystemPage/BackupSchedulePanel';
import type { BackupInfo, BackupSchedule } from '../SystemPage/types';
import { formatBytes } from '../SystemPage/types';
import styles from '../SystemPage/SystemPage.module.css';

export function BackupsPage() {
  const { t } = useTranslation();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [includeConfiguration, setIncludeConfiguration] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState('');
  const [schedule, setSchedule] = useState<BackupSchedule>({ frequency: 'off', includeUploads: false, retention: 7, lastRunAt: '' });
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleState, setScheduleState] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [backupData, loadedSchedule] = await Promise.all([
        api<{ creating: boolean; restoring: boolean; backups: BackupInfo[] }>('/api/backups'),
        api<BackupSchedule>('/api/backups/schedule'),
      ]);
      setBackups(backupData.backups); setCreating(backupData.creating); setRestoring(backupData.restoring); setSchedule(loadedSchedule); setState('');
    } catch (error) {
      setState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function createBackup() {
    setCreating(true);
    setState(includeUploads ? t('system.backups.creatingDbAndFiles') : t('system.backups.creatingDb'));
    try {
      await api('/api/backups', { method: 'POST', body: JSON.stringify({ includeUploads, includeConfiguration }) });
      await load(); setState(t('system.backups.created'));
    } catch (error) {
      setState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setCreating(false); }
  }

  async function deleteBackup(backup: BackupInfo) {
    if (!window.confirm(t('system.backups.deleteConfirm', { name: backup.name }))) return;
    setState(t('system.backups.deleting'));
    try {
      await api(`/api/backups/${encodeURIComponent(backup.name)}`, { method: 'DELETE', body: '{}' });
      await load(); setState(t('system.backups.deleted'));
    } catch (error) {
      setState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  async function importBackup(file: File) {
    setImporting(true); setImportProgress(0); setState(t('system.backups.uploading', { name: file.name, percent: 0, loaded: formatBytes(0), total: formatBytes(file.size) }));
    try {
      await uploadBackup(file, (loaded, total) => {
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        setImportProgress(percent);
        setState(t('system.backups.uploading', { name: file.name, percent, loaded: formatBytes(loaded), total: formatBytes(total) }));
      }, () => setState(t('system.backups.uploaded')));
      await load(); setState(t('system.backups.imported'));
    } catch (error) {
      setState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setImporting(false); setImportProgress(null); }
  }

  async function restoreSelectedBackup(backup: BackupInfo) {
    if (!window.confirm(t('system.backups.restoreConfirm', { name: backup.name }))) return;
    setRestoring(true); setState(t('system.backups.restoring'));
    try {
      await api(`/api/backups/${encodeURIComponent(backup.name)}/restore`, { method: 'POST', body: '{}' });
      await load(); setState(t('system.backups.restored'));
    } catch (error) {
      setState(t('system.backups.restoreError', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setRestoring(false); }
  }

  async function saveSchedule() {
    setScheduleSaving(true); setScheduleState(t('system.schedule.saving'));
    try {
      const saved = await api<BackupSchedule>('/api/backups/schedule', { method: 'PUT', body: JSON.stringify(schedule) });
      setSchedule(saved); setScheduleState(t('system.schedule.saved'));
    } catch (error) {
      setScheduleState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setScheduleSaving(false); }
  }

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}><span>{loading ? t('system.updating') : t('system.dataFrom')}</span><button type="button" className="buttonSecondary" onClick={() => void load()} disabled={loading}>{t('system.refresh')}</button></div>
      <Card title={t('system.schedule.title')} description={t('system.schedule.description')}><BackupSchedulePanel schedule={schedule} saving={scheduleSaving} state={scheduleState} onChange={(patch) => { setSchedule((current) => ({ ...current, ...patch })); setScheduleState(''); }} onSave={() => void saveSchedule()} /></Card>
      <Card title={t('system.backups.title')} description={t('system.backups.description')}>
        <BackupsPanel backups={backups} creating={creating} restoring={restoring} importing={importing} importProgress={importProgress} includeUploads={includeUploads} includeConfiguration={includeConfiguration} state={state} onIncludeUploadsChange={setIncludeUploads} onIncludeConfigurationChange={setIncludeConfiguration} onCreate={() => void createBackup()} onImport={(file) => void importBackup(file)} onRestore={(backup) => void restoreSelectedBackup(backup)} onDelete={(backup) => void deleteBackup(backup)} />
      </Card>
    </div>
  );
}

function uploadBackup(file: File, onProgress: (loaded: number, total: number) => void, onUploaded: () => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/backups/import?filename=${encodeURIComponent(file.name)}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    request.upload.addEventListener('load', onUploaded);
    request.addEventListener('load', () => {
      let body: { error?: string } = {};
      try { body = JSON.parse(request.responseText); } catch { /* The HTTP status is enough. */ }
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(body.error || `HTTP ${request.status}`));
    });
    request.addEventListener('error', () => reject(new Error('Failed to upload file')));
    request.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    request.send(file);
  });
}
