import { apiFetch } from './api';

export type ApprovalStrictness = 'strict' | 'normal' | 'relaxed';
export type CommandAssessment = {
  status: 'ready' | 'unavailable';
  approved: boolean;
  auto: number | null;
  know: number | null;
  thresholds: { auto: number; know: number };
};
export type AutoConfirmationConfig = {
  revision: number;
  available: boolean;
  settings: {
    enabled: boolean;
    strictness: ApprovalStrictness;
    overrides: Record<string, boolean>;
  };
  thresholds: Record<ApprovalStrictness, { auto: number; know: number }>;
};
export type AutoConfirmationUpdate =
  | { revision: number; enabled: boolean; strictness: ApprovalStrictness }
  | { revision: number; serverId: number; enabled: boolean | null }
  | { revision: number; resetOverrides: true };
const endpoint = '/api/v1/auto-confirmation';
export const getAutoConfirmation = () => apiFetch<AutoConfirmationConfig>(endpoint);
export const saveAutoConfirmation = (update: AutoConfirmationUpdate) =>
  apiFetch<AutoConfirmationConfig>(endpoint, { method: 'PUT', body: JSON.stringify(update) });
