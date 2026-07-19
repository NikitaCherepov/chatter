'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { BackupsPanel } from './BackupsPanel';
import { BackupSchedulePanel } from './BackupSchedulePanel';
import { ServerMetrics } from './ServerMetrics';
import { ServerUpdatePanel } from './ServerUpdatePanel';
import type { BackupInfo, BackupSchedule, SystemInfo } from './types';
import { formatBytes } from './types';
import styles from './SystemPage.module.css';

export function SystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState('');
  const [schedule, setSchedule] = useState<BackupSchedule>({ frequency: 'off', includeUploads: false, retention: 7, lastRunAt: '' });
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleState, setScheduleState] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [system, backupData, loadedSchedule] = await Promise.all([
        api<SystemInfo>('/api/system'),
        api<{ creating: boolean; restoring: boolean; backups: BackupInfo[] }>('/api/backups'),
        api<BackupSchedule>('/api/backups/schedule'),
      ]);
      setInfo(system); setBackups(backupData.backups); setCreating(backupData.creating); setRestoring(backupData.restoring); setSchedule(loadedSchedule); setState('');
    } catch (error) {
      setState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createBackup() {
    setCreating(true);
    setState(includeUploads ? 'Создаём архив базы данных и файлов…' : 'Создаём снимок базы данных…');
    try {
      await api('/api/backups', { method: 'POST', body: JSON.stringify({ includeUploads }) });
      await load(); setState('Бэкап создан.');
    } catch (error) {
      setState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setCreating(false); }
  }

  async function deleteBackup(backup: BackupInfo) {
    if (!window.confirm(`Удалить резервную копию ${backup.name}?`)) return;
    setState('Удаляем резервную копию…');
    try {
      await api(`/api/backups/${encodeURIComponent(backup.name)}`, { method: 'DELETE', body: '{}' });
      await load(); setState('Бэкап удалён.');
    } catch (error) {
      setState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function importBackup(file: File) {
    setImporting(true); setState(`Проверяем и импортируем ${file.name}…`);
    try {
      const response = await fetch(`/api/backups/import?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load(); setState('Файл импортирован. Теперь его можно восстановить.');
    } catch (error) {
      setState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setImporting(false); }
  }

  async function restoreSelectedBackup(backup: BackupInfo) {
    if (!window.confirm(`Восстановить ${backup.name}? Сервисы будут ненадолго остановлены, а текущие данные автоматически попадут в страховочный бэкап.`)) return;
    setRestoring(true); setState('Проверяем архив, создаём страховочную копию и восстанавливаем данные…');
    try {
      await api(`/api/backups/${encodeURIComponent(backup.name)}/restore`, { method: 'POST', body: '{}' });
      await load(); setState('Данные восстановлены, сервисы запущены.');
    } catch (error) {
      setState(`Ошибка восстановления: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setRestoring(false); }
  }

  async function saveSchedule() {
    setScheduleSaving(true); setScheduleState('Сохраняем…');
    try {
      const saved = await api<BackupSchedule>('/api/backups/schedule', { method: 'PUT', body: JSON.stringify(schedule) });
      setSchedule(saved); setScheduleState('Расписание сохранено.');
    } catch (error) {
      setScheduleState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setScheduleSaving(false); }
  }

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}><span>{loading ? 'Обновляем данные…' : 'Данные получены от Chatter Manager'}</span><button type="button" className="buttonSecondary" onClick={() => void load()} disabled={loading}>Обновить</button></div>
      {info && <><Card title="Состояние сервера" description="CPU, память, swap и место на диске"><ServerMetrics info={info} /></Card><div className={styles.storageGrid}><StorageItem title="База данных" value={formatBytes(info.storage.databaseSize)} /><StorageItem title="Загруженные файлы" value={formatBytes(info.storage.uploadsSize)} /><StorageItem title="Резервные копии" value={formatBytes(info.storage.backupsSize)} /></div></>}
      <ServerUpdatePanel />
      <Card title="Автоматические бэкапы" description="Manager запускает их сам, отдельный cron не требуется"><BackupSchedulePanel schedule={schedule} saving={scheduleSaving} state={scheduleState} onChange={(patch) => { setSchedule((current) => ({ ...current, ...patch })); setScheduleState(''); }} onSave={() => void saveSchedule()} /></Card>
      <Card title="Резервные копии" description="База данных включается всегда, медиафайлы — по желанию">
        <BackupsPanel backups={backups} creating={creating} restoring={restoring} importing={importing} includeUploads={includeUploads} state={state} onIncludeUploadsChange={setIncludeUploads} onCreate={() => void createBackup()} onImport={(file) => void importBackup(file)} onRestore={(backup) => void restoreSelectedBackup(backup)} onDelete={(backup) => void deleteBackup(backup)} />
      </Card>
    </div>
  );
}

function StorageItem({ title, value }: { title: string; value: string }) {
  return <article><span>{title}</span><strong>{value}</strong></article>;
}
