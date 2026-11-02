import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuth } from './auth';
import * as api from './api';
const defaults: api.FeatureFlags = { disable_memory_write: false, disable_pc_control_lite: false, disable_pc_control_full: false, disable_pc_commands: false, disable_internet: false, disable_personal: false, disable_specialized_subagents: false, disable_adhoc_subagents: false, disable_avatar_control: false, hide_pixel_avatar: false };
export function useFeatureFlags(enabled = true) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = ['feature-flags', api.API_BASE, user?.id] as const;
  const query = useQuery({ queryKey: key, queryFn: api.getFeatureFlags, enabled: enabled && Boolean(user), staleTime: 60_000, retry: 1 });
  const saving = useIsMutating({ mutationKey: key }) > 0;
  const mutation = useMutation({ mutationKey: key,
    mutationFn: (flags: api.FeatureFlags) => api.setFeatureFlags(flags),
    onMutate: async flags => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<{ flags: api.FeatureFlags }>(key);
      client.setQueryData(key, { flags });
      return { previous, key };
    },
    onSuccess: (response, _flags, context) => client.setQueryData(context.key, { flags: response.flags }),
    onError: (_error, _flags, context) => {
      if (context?.previous) client.setQueryData(context.key, context.previous);
      toast.error(t('settings.toasts.saveSettingsFailed'));
    },
  });
  const setFlag = (name: keyof api.FeatureFlags, value: boolean) => {
    const current = client.getQueryData<{ flags: api.FeatureFlags }>(key);
    if (!user || !current || client.isMutating({ mutationKey: key }) || query.isError) return;
    mutation.mutate({ ...current.flags, [name]: value });
  };
  return { flags: query.data?.flags ?? defaults, loading: query.isPending, loadFailed: query.isError,
    saving, setFlag, retry: () => { void query.refetch(); } };
}
