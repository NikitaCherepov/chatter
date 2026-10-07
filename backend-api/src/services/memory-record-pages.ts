import { db } from '../db.js';
import { resolveAccountId } from './accounts.js';
import type { MemorySpace, MemoryRecord } from './memory-foundation.js';

db.function('memory_contains', { deterministic: true }, (text, query) => String(text ?? '').toLocaleLowerCase().includes(String(query ?? '').toLocaleLowerCase()) ? 1 : 0);
export function parseMemoryPage(query: Record<string, unknown>) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  const search = typeof query.query === 'string' ? query.query.trim() : '';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || search.length > 300) throw new Error('bad_memory_pagination');
  return { limit, offset, search };
}
export function getMemoryRecordPage(userId: number, space: MemorySpace, options: ReturnType<typeof parseMemoryPage>) {
  const accountId = resolveAccountId(userId);
  if (space.user_id !== accountId) throw new Error('memory_space_not_found');
  const where = `FROM memory_records r JOIN memory_spaces s ON s.id = r.memory_space_id
    WHERE r.user_id = ? AND s.user_id = ? AND r.memory_space_id = ? AND s.archived_at IS NULL AND r.deleted_at IS NULL
    AND (? = '' OR memory_contains(r.source || char(10) || r.text, ?))`;
  const params = [accountId, accountId, space.id, options.search, options.search];
  const total = (db.prepare(`SELECT count(*) AS total ${where}`).get(...params) as { total: number }).total;
  const records = db.prepare(`SELECT r.* ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset) as MemoryRecord[];
  return { records, total, limit: options.limit, offset: options.offset, nextOffset: options.offset + records.length < total ? options.offset + records.length : null };
}
