import type { UserRecord } from '../../../types.js';
import { consumeUserQuota, getUserQuota } from '../../monthly-usage.js';

const normalizedLimit = (value: number | null | undefined) => {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.floor(Number(value)));
};

export const checkWebSearchQuota = (user: UserRecord) => {
  const quota = getUserQuota(user.id, 'web_search');
  const limit = normalizedLimit(quota?.limit ?? 0);
  const count = Math.max(0, Math.floor(Number(quota?.used || 0)));
  if (limit <= 0) return { allowed: false, count, limit, reason: 'Tavily search is disabled under your plan.' };
  if (count >= limit) return { allowed: false, count, limit, reason: `Monthly Tavily search limit exhausted (${count}/${limit}).` };
  return { allowed: true, count, limit, reason: '' };
};

export const checkWebReaderQuota = (user: UserRecord) => {
  const quota = getUserQuota(user.id, 'web_reader');
  const limit = normalizedLimit(quota?.limit ?? 0);
  const count = Math.max(0, Math.floor(Number(quota?.used || 0)));
  if (limit <= 0) return { allowed: false, count, limit, reason: 'Browserless page reading is disabled under your plan.' };
  if (count >= limit) return { allowed: false, count, limit, reason: `Monthly Browserless page reading limit exhausted (${count}/${limit}).` };
  return { allowed: true, count, limit, reason: '' };
};

export const consumeWebSearchQuota = (userId: number) => consumeUserQuota(userId, 'web_search', 1);
export const consumeWebReaderQuota = (userId: number) => consumeUserQuota(userId, 'web_reader', 1);
