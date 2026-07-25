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

export type UpdateState = {
  preparing: boolean;
  activeUsers: number;
  elapsedMs: number;
};

export const UPDATE_DRAIN_TIMEOUT_MS = 15_000;
export const UPDATE_POLL_INTERVAL_MS = 2_000;

export const serverUpdateService = {
  getStatus: () => api<ServerUpdateInfo>('/api/server-update'),
  refresh: () => api<ServerUpdateInfo>('/api/server-update?refresh=1'),
  forceRefresh: () => api<ServerUpdateInfo>('/api/server-update?refresh=1&force=1'),
  apply: () => api('/api/server-update', { method: 'POST', body: '{}' }),

  // Update drain endpoints (proxied by chatter-manager -> backend-api)
  getUpdateState: () => api<UpdateState>('/api/update/prepare'),
  prepareUpdate: () => api<UpdateState>('/api/update/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'prepare' }),
  }),
  cancelUpdate: () => api<UpdateState>('/api/update/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'cancel' }),
  }),
  extendUpdate: () => api<UpdateState>('/api/update/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'extend' }),
  }),
  forceUpdate: () => api<{ aborted: number }>('/api/update/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'force' }),
  }),
};
