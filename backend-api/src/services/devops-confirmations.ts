/**
 * Shared in-memory store for pending DevOps command confirmations.
 * Used by ai.ts (registers) and server.ts (resolves/rejects via /approve endpoint).
 */

export type PendingDevopsConfirmation = {
  userId: number;
  serverId: number;
  command: string;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  createdAt: number;
};

const pendingConfirmations = new Map<string, PendingDevopsConfirmation>();

export const registerPendingConfirmation = (id: string, pending: PendingDevopsConfirmation) => {
  pendingConfirmations.set(id, pending);
};

export const getPendingConfirmation = (id: string): PendingDevopsConfirmation | undefined => {
  return pendingConfirmations.get(id);
};

export const deletePendingConfirmation = (id: string): boolean => {
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
