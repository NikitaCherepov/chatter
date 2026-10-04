import { useQuery, useQueryClient } from '@tanstack/react-query';
import { serverUpdateService, type ServerUpdateInfo } from '../services/serverUpdateService';
import { activeUpdateStatuses } from '../services/serverUpdateState';

export function useServerUpdate() {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['server-update'],
    queryFn: () => {
      const current = queryClient.getQueryData<ServerUpdateInfo>(['server-update']);
      return current && activeUpdateStatuses.has(current.operation.status)
        ? serverUpdateService.getStatus()
        : serverUpdateService.refresh();
    },
    staleTime: 5 * 60_000,
    refetchInterval: (query) => {
      const status = query.state.data?.operation.status;
      return status && activeUpdateStatuses.has(status) ? 2_000 : false;
    },
  });
}
