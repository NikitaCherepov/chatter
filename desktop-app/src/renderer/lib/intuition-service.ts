import { apiFetch } from './api';
export type IntuitionQuestion = { id: string; name: string; question: string; enabled: boolean };
export type IntuitionSettings = {
  mode: 'inherit' | 'enabled' | 'disabled';
  historyMessages: number | null;
  questions: IntuitionQuestion[] | null;
};
export type IntuitionSnapshot = {
  status: 'ready' | 'unavailable';
  createdAt: number;
  fingerprint: string;
  model: string;
  historyMessages: number;
  elapsedMs?: number;
  signals: Array<IntuitionQuestion & { probability: number }>;
};
export type IntuitionConfig = {
  settings: IntuitionSettings;
  revision: number;
  available: boolean;
  defaults: IntuitionQuestion[];
  inherited?: { historyMessages: number; questions: IntuitionQuestion[] };
  effective: { enabled: boolean; historyMessages: number; questions: IntuitionQuestion[] };
};
const endpoint = (chatId?: number) => '/api/v1/intuition' + (chatId ? '?chat_id=' + chatId : '');
export const getIntuition = (chatId?: number, signal?:AbortSignal) => apiFetch<IntuitionConfig>(endpoint(chatId),{signal});
export const saveIntuition = (
  chatId: number | undefined,
  settings: IntuitionSettings,
  revision: number,
) =>
  apiFetch<IntuitionConfig>(endpoint(chatId), {
    method: 'PUT',
    body: JSON.stringify({ settings, revision }),
  });
export const suggestIntuition = (
  chatId: number | undefined,
  brief: string,
  includeHistory: boolean,
  signal?:AbortSignal,
) =>
  apiFetch<{ questions: IntuitionQuestion[] }>(
    '/api/v1/intuition/suggest' + (chatId ? '?chat_id=' + chatId : ''),
    { method: 'POST', body: JSON.stringify({ brief, includeHistory }),signal },
  );
