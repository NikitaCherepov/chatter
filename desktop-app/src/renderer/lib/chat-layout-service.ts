import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { API_BASE, apiFetch } from './api';
import { parseChatLayoutSettings, type ChatLayoutCommand, type ChatLayoutSettings } from './chat-layout-schema';

const endpoint = '/api/v1/user/chat-layout';

async function requestLayout(command?: ChatLayoutCommand, signal?: AbortSignal) {
  const result = await apiFetch<{ layout: ChatLayoutSettings }>(endpoint, command
    ? { method: 'POST', body: JSON.stringify(command) }
    : { signal });
  return parseChatLayoutSettings(result.layout);
}

export function useChatLayouts() {
  const { user, setUser } = useAuth();
  const client = useQueryClient();
  const key = ['chat-layout', API_BASE, user?.id ?? null] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => requestLayout(undefined, signal),
    enabled: Boolean(user),
    initialData: user?.ui_settings?.chat_layout,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: ({ command }: { command: ChatLayoutCommand; accountKey: typeof key }) => requestLayout(command),
    onSuccess: async (layout, { accountKey }) => {
      await client.cancelQueries({ queryKey: accountKey, exact: true });
      client.setQueryData<ChatLayoutSettings>(accountKey, previous =>
        previous && previous.revision > layout.revision ? previous : layout);
      setUser(previous => previous && previous.id === accountKey[2] && API_BASE === accountKey[1]
        && (previous.ui_settings?.chat_layout?.revision ?? 0) <= layout.revision
        ? { ...previous, ui_settings: { ...previous.ui_settings, chat_layout: layout } }
        : previous);
    },
    onError: (_, { accountKey }) => { void client.invalidateQueries({ queryKey: accountKey, exact: true }); },
  });
  return {
    state: query.data,
    failed: query.isError,
    retry: query.refetch,
    change: (command: ChatLayoutCommand) => mutation.mutateAsync({ command, accountKey: key }),
    saving: mutation.isPending,
  };
}

export type ChatLayouts = ReturnType<typeof useChatLayouts>;
