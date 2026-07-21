import { useQuery, useQueryClient } from '@tanstack/react-query';
import { serverUpdateService, type ServerUpdateInfo } from '../services/serverUpdateService';

const activeStatuses = new Set(['queued', 'backup', 'restarting']);

export function useServerUpdate() {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['server-update'],
    queryFn: () => {
      const current = queryClient.getQueryData<ServerUpdateInfo>(['server-update']);
      return current && activeStatuses.has(current.operation.status)
        ? serverUpdateService.getStatus()
        : serverUpdateService.refresh();
    },
    staleTime: 5 * 60_000,
    refetchInterval: (query) => {
      const status = query.state.data?.operation.status;
      return status && activeStatuses.has(status) ? 2_000 : false;
    },
  });
}
