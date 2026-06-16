/**
 * Shared in-memory store for pending visual click confirmations.
 * Used by ai.ts (registers) and server.ts (resolves/rejects via /approve endpoint).
 */

export type PendingVisualClickConfirmation = {
  userId: number;
  display_id: string;
  x: number;
  y: number;
  button: string;
  reason: string;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  createdAt: number;
};

const pendingConfirmations = new Map<string, PendingVisualClickConfirmation>();

export const registerPendingVisualClick = (id: string, pending: PendingVisualClickConfirmation) => {
  pendingConfirmations.set(id, pending);
};

export const getPendingVisualClick = (id: string): PendingVisualClickConfirmation | undefined => {
  return pendingConfirmations.get(id);
};

export const deletePendingVisualClick = (id: string): boolean => {
  return pendingConfirmations.delete(id);
};

// Auto-cleanup expired (60 sec TTL — short, because visual context changes fast)
setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingConfirmations) {
    if (now - pending.createdAt > 60 * 1000) {
      pending.reject(new Error('confirmation_expired'));
      pendingConfirmations.delete(id);
    }
  }
}, 15_000);
