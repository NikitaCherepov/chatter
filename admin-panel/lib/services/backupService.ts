import { api } from '../api';
import type { BackupInfo, BackupSchedule } from '../../components/pages/SystemPage/types';

export type BackupsResponse = {
  creating: boolean;
  restoring: boolean;
  backups: BackupInfo[];
};

export const backupService = {
  getBackups: () => api<BackupsResponse>('/api/backups'),
  getSchedule: () => api<BackupSchedule>('/api/backups/schedule'),
  create: (includeUploads: boolean, includeConfiguration: boolean) =>
    api('/api/backups', { method: 'POST', body: JSON.stringify({ includeUploads, includeConfiguration }) }),
  delete: (name: string) =>
    api(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' }),
  restore: (name: string) =>
    api(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: '{}' }),
  saveSchedule: (schedule: BackupSchedule) =>
    api<BackupSchedule>('/api/backups/schedule', { method: 'PUT', body: JSON.stringify(schedule) }),
};

export function uploadBackup(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  onUploaded: () => void,
): Promise<void> {
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
