import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { API_BASE } from './api';
import { useAuth } from './auth';
import { getMcpCatalog } from './mcp-service';
import { useSettingsRead } from './useSettingsQueries';
export function useMcp() {
  const { user } = useAuth(),
    client = useQueryClient(),
    key = ['settings', API_BASE, user?.id, 'mcp'];
  const query = useSettingsRead('mcp', user?.id, true);
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  return { query, mutation };
}

export function useMcpCatalog(search: string | null, enabled: boolean) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['settings', API_BASE, user?.id, 'mcp', 'catalog', search],
    queryFn: ({ pageParam, signal }) => getMcpCatalog(search || '', pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (page) => page.next_cursor || undefined,
    enabled: !!user && enabled && search !== null,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
