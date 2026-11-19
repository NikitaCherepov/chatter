import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import * as api from './api';
import {
  parseAppearanceSettings,
  type AppearanceProfile,
  type AppearanceSettings,
} from './appearance-schema';
export type AppearanceCommand =
  | { action: 'save'; profile: AppearanceProfile; apply: boolean }
  | { action: 'activate'; id: string | null; revision: number }
  | { action: 'delete'; id: string; revision: number };
export async function fetchAppearance() {
  const response = await api.apiFetch<{ appearance: AppearanceSettings }>(
    '/api/v1/user/appearance',
  );
  return parseAppearanceSettings(response.appearance);
}
export async function updateAppearance(command: AppearanceCommand) {
  const response = await api.apiFetch<{ appearance: AppearanceSettings }>(
    '/api/v1/user/appearance',
    { method: 'POST', body: JSON.stringify(command) },
  );
  return parseAppearanceSettings(response.appearance);
}
export function useAppearance() {
  const { user, setUser } = useAuth(),
    client = useQueryClient();
  const key = ['appearance', api.API_BASE, user?.id ?? null] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: fetchAppearance,
    enabled: !!user,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: updateAppearance,
    onSuccess: (appearance) => {
      client.setQueryData(key, appearance);
      setUser((previous) =>
        previous?.id === key[2]
          ? { ...previous, ui_settings: { ...previous.ui_settings, appearance } }
          : previous,
      );
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  return { ...query, change: mutation.mutateAsync, saving: mutation.isPending };
}
