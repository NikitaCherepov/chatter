import { useMutation, useQueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { API_BASE } from './api';
import { useAuth } from './auth';
import { getMcpCatalog, getLocalMcp, getLocalMcpSettings } from './mcp-service';
import { useSettingsRead } from './useSettingsQueries';
export function useMcp() {
  const { user } = useAuth(),
    client = useQueryClient(),
    key = ['settings', API_BASE, user?.id, 'mcp'];
  const query = useSettingsRead('mcp', user?.id, true);
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
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

export function useLocalMcp() {
  const { user } = useAuth(),
    client = useQueryClient();
  const available = !!window.electronAPI?.localMcpManage;
  const key = ['settings', API_BASE, user?.id, 'mcp'];
  const query = useQuery({
    queryKey: [...key, 'local'],
    queryFn: () => getLocalMcp(),
    enabled: available && !!user,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  return { query, mutation, available };
}

export function useLocalMcpSettings(id: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['settings', API_BASE, user?.id, 'mcp', 'local-settings', id],
    queryFn: () => getLocalMcpSettings(id),
    enabled: !!user && !!window.electronAPI?.localMcpManage,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });
}
