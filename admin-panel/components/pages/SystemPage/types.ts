export type SystemInfo = {
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  cpu: { model: string; cores: number; usagePercent: number; loadAverage: number[] };
  memory: { total: number; used: number; available: number };
  swap: { total: number; used: number; available: number };
  disk: { total: number; used: number; available: number };
  storage: { databaseSize: number; uploadsSize: number; backupsSize: number };
};

export type BackupInfo = {
  name: string;
  size: number;
  createdAt: string;
  includesUploads?: boolean;
  includesConfiguration?: boolean;
  version?: string;
  source?: 'manual' | 'automatic';
};

export type BackupSchedule = {
  frequency: 'off' | 'daily' | 'weekly';
  includeUploads: boolean;
  retention: number;
  lastRunAt: string;
};

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}min`].filter(Boolean).join(' ');
}
