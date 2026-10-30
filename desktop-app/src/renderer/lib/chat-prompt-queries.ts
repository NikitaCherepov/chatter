import { useQuery } from '@tanstack/react-query';
import { useAuth } from './auth';
import * as api from './api';

export type ChatPromptSettings = {
  prompt_id: number | null;
  room_enabled: boolean;
  effective_prompt?: { id: number; name: string; image_url: string | null } | null;
};

export function useChatPromptKey(chatId?: number | null) {
  const { user } = useAuth();
  return ['chat-prompt', api.API_BASE, user?.id ?? null, chatId ?? null] as const;
}

export function useChatPromptSettings(chatId: number | null) {
  const key = useChatPromptKey(chatId);
  return useQuery({
    queryKey: key,
    enabled: chatId !== null && key[2] !== null,
    queryFn: () => api.apiFetch<{ settings: ChatPromptSettings }>(`/api/v1/chats/${chatId}/prompt-settings`),
    staleTime: 0,
  });
}
