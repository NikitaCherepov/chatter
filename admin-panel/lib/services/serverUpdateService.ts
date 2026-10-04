import { api } from '../api';

export type UpdateOperation = {
  operationId?: string;
  status: 'idle' | 'queued' | 'pulling' | 'backup' | 'restarting' | 'complete' | 'failed';
  targetHash: string;
  message: string;
  updatedAt: string | null;
};

export type ServerUpdateInfo = {
  supported: boolean;
  /** Image tag (= update channel): `latest` for production, branch tag otherwise. */
  imageTag?: string;
  installedHash: string;
  latestHash: string;
  available: boolean;
  changedServices: string[];
  changelog: Record<string, string[]>;
  rebuiltFromSameCommit: boolean;
  checkedAt: string | null;
  storage?: {
    totalBytes: number;
    availableBytes: number;
    requiredBytes: number;
    imageDownloadBytes: number;
    backupWorkingBytes: number;
    sufficient: boolean;
  };
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
  apply: () => api<{ ok: true; targetHash: string; operation: UpdateOperation }>('/api/server-update', { method: 'POST', body: '{}' }),
  // Switch the update channel (image tag). `latest` = production, a branch
  // tag (with `/` replaced by `-`) tracks that branch's images.
  setTag: (tag: string) => api<{ ok: true; imageTag: string }>('/api/server-update/tag', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  }),

  // Shared backend restart drain endpoints (proxied by chatter-manager -> backend-api)
  getUpdateState: () => api<UpdateState>('/api/restart/prepare'),
  prepareUpdate: () => api<UpdateState>('/api/restart/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'prepare' }),
  }),
  cancelUpdate: () => api<UpdateState>('/api/restart/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'cancel' }),
  }),
  forceUpdate: () => api<{ aborted: number }>('/api/restart/prepare', {
    method: 'POST',
    body: JSON.stringify({ action: 'force' }),
  }),
};
