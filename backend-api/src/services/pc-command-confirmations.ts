/**
 * Shared in-memory store for pending PC command confirmations.
 * Used by ai.ts (registers) and server.ts (resolves/rejects via /approve endpoint).
 */

export type PendingPcCommandConfirmation = {
  userId: number;
  command: string;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  createdAt: number;
};

const pendingConfirmations = new Map<string, PendingPcCommandConfirmation>();

export const registerPendingPcConfirmation = (id: string, pending: PendingPcCommandConfirmation) => {
  pendingConfirmations.set(id, pending);
};

export const getPendingPcConfirmation = (id: string): PendingPcCommandConfirmation | undefined => {
  return pendingConfirmations.get(id);
};

export const deletePendingPcConfirmation = (id: string): boolean => {
  return pendingConfirmations.delete(id);
};

// Auto-cleanup expired (5 min TTL)
setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingConfirmations) {
    if (now - pending.createdAt > 5 * 60 * 1000) {
      pending.reject(new Error('confirmation_expired'));
      pendingConfirmations.delete(id);
    }
  }
}, 30_000);
