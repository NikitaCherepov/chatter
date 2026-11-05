import { useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from './api';
import { useAuth } from './auth';
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
