import { useQuery } from '@tanstack/react-query';
import { systemService, type MetricsRange } from '../services/systemService';

export function useSystemMetrics(range: MetricsRange) {
  return useQuery({
    queryKey: ['system', 'metrics', range],
    queryFn: () => systemService.getMetrics(range),
    refetchInterval: 60_000,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: ['system', 'info'],
    queryFn: () => systemService.getInfo(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
