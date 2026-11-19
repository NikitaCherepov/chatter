import { apiFetch } from './api';

export type ApprovalStrictness = 'strict' | 'normal' | 'relaxed' | 'custom';
export type ApprovalThresholds = { auto: number; know: number };
export type ApprovalScope = 'servers' | 'pc';
export type ApprovalSettings = {
  enabled: boolean;
  strictness: ApprovalStrictness;
  customThresholds: ApprovalThresholds;
};
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
    customThresholds: ApprovalThresholds;
    pc: ApprovalSettings;
  };
  thresholds: Record<ApprovalStrictness, { auto: number; know: number }>;
  pcThresholds: Record<ApprovalStrictness, { auto: number; know: number }>;
};
export type AutoConfirmationUpdate =
  | {
      revision: number;
      enabled: boolean;
      strictness: ApprovalStrictness;
      customThresholds?: ApprovalThresholds;
      scope?: ApprovalScope;
    }
  | { revision: number; serverId: number; enabled: boolean | null }
  | { revision: number; resetOverrides: true };
const endpoint = '/api/v1/auto-confirmation';
export const getAutoConfirmation = () => apiFetch<AutoConfirmationConfig>(endpoint);
export const saveAutoConfirmation = (update: AutoConfirmationUpdate) =>
  apiFetch<AutoConfirmationConfig>(endpoint, { method: 'PUT', body: JSON.stringify(update) });
