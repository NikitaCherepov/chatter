import { api } from '../api';

export type UpdateOperation = {
  status: 'idle' | 'queued' | 'backup' | 'restarting' | 'complete' | 'failed';
  targetHash: string;
  message: string;
  updatedAt: string | null;
};

export type ServerUpdateInfo = {
  supported: boolean;
  installedHash: string;
  latestHash: string;
  available: boolean;
  changedServices: string[];
  changelog: Record<string, string[]>;
  rebuiltFromSameCommit: boolean;
  checkedAt: string | null;
  operation: UpdateOperation;
};

export const serverUpdateService = {
  getStatus: () => api<ServerUpdateInfo>('/api/server-update'),
  refresh: () => api<ServerUpdateInfo>('/api/server-update?refresh=1'),
  forceRefresh: () => api<ServerUpdateInfo>('/api/server-update?refresh=1&force=1'),
  apply: () => api('/api/server-update', { method: 'POST', body: '{}' }),
};
