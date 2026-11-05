import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from './api';
import { useAuth } from './auth';
import * as service from './mcp-service';
export function useMcp() {
  const { user } = useAuth(),
    client = useQueryClient(),
    key = ['settings', API_BASE, user?.id, 'mcp'];
  const query = useQuery({
    queryKey: key,
    queryFn: service.getMcpState,
    enabled: !!user,
    staleTime: 30_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  return { query, mutation };
}
