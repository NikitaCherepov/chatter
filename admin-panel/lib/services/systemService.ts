import { api } from '../api';
import type { SystemInfo } from '../../components/pages/SystemPage/types';

export type MetricPoint = {
  ts: number;
  cpu: number;
  mem: number;
  swap: number;
  disk: number;
};

export type MetricsResponse = {
  range: string;
  points: MetricPoint[];
};

export type MetricsRange = '24h' | '3d' | '7d';

export const systemService = {
  getInfo: () => api<SystemInfo>('/api/system'),

  getMetrics: (range: MetricsRange = '24h') =>
    api<MetricsResponse>(`/api/system/metrics?range=${range}`),
};
