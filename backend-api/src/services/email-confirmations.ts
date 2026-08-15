/**
 * Shared in-memory store for pending email send confirmations.
 * Used by ai.ts (registers) and server.ts (resolves/rejects via /approve endpoint).
 */

import { sendToDesktop } from '../ws-clients.js';

export type PendingEmailConfirmation = {
  userId: number;
  to: string;
  subject: string;
  body: string;
  provider?: string;
  mailAccountId?: number;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  createdAt: number;
};

const pendingConfirmations = new Map<string, PendingEmailConfirmation>();

export const registerPendingEmailConfirmation = (id: string, pending: PendingEmailConfirmation) => {
  pendingConfirmations.set(id, pending);
};

export const getPendingEmailConfirmation = (id: string): PendingEmailConfirmation | undefined => {
  return pendingConfirmations.get(id);
};

export const deletePendingEmailConfirmation = (id: string): boolean => {
  return pendingConfirmations.delete(id);
};

// Auto-cleanup expired (5 min TTL)
setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingConfirmations) {
    if (now - pending.createdAt > 5 * 60 * 1000) {
      pending.reject(new Error('confirmation_expired'));
      pendingConfirmations.delete(id);
      sendToDesktop(pending.userId, {
        type: 'desktop_action',
        action: 'confirmation_resolved',
        value: { confirmation_id: id, status: 'expired' },
      });
    }
  }
}, 30_000);
