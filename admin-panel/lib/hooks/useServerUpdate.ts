import { useQuery } from '@tanstack/react-query';
import { serverUpdateService } from '../services/serverUpdateService';

const activeStatuses = new Set(['queued', 'backup', 'restarting']);

export function useServerUpdate() {
  return useQuery({
    queryKey: ['server-update'],
    queryFn: () => serverUpdateService.refresh(),
    staleTime: 5 * 60_000,
    refetchInterval: (query) => {
      const status = query.state.data?.operation.status;
      return status && activeStatuses.has(status) ? 2_000 : false;
    },
  });
}
