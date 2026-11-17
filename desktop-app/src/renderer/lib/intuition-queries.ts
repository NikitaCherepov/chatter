import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from './api';
import { useAuth } from './auth';
import { getIntuition, saveIntuition, type IntuitionSettings } from './intuition-service';

export function useIntuitionSettings(chatId?: number) {
  const { user } = useAuth();
  const client = useQueryClient();
  const prefix = ['intuition', API_BASE, user?.id];
  const key = [...prefix, chatId ?? 'global'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getIntuition(chatId),
    enabled: Boolean(user),
    staleTime: 60000,
  });
  const save = useMutation({
    mutationFn: ({ settings, revision }: { settings: IntuitionSettings; revision: number }) =>
      saveIntuition(chatId, settings, revision),
    onSuccess: async (data) => {
      client.setQueryData(key, data);
      await client.invalidateQueries({ queryKey: prefix, refetchType: 'active' });
    },
  });
  return { query, save };
}
