import { db } from '../db.js';
import { resolveAccountId } from './accounts.js';
import { getChatMemorySettings } from './memory-foundation.js';
import { getMemoryDefaultResultLimit } from './vector-memory-settings.js';

export const getMemoryPreferences = (userId: number) => {
  const accountId = resolveAccountId(userId);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(accountId)) throw new Error('user_not_found');
  const raw = db.prepare('SELECT automatic_memory, result_limit FROM user_memory_preferences WHERE user_id = ?').get(accountId) as { automatic_memory: number; result_limit: number | null } | undefined;
  const resultLimit = raw?.result_limit ?? null;
  const adminResultLimit = getMemoryDefaultResultLimit();
  return { automatic_memory: raw?.automatic_memory === 1, result_limit: resultLimit, admin_result_limit: adminResultLimit, effective_result_limit: resultLimit ?? adminResultLimit };
};
export const updateMemoryPreferences = (userId: number, patch: { automatic_memory?: boolean; result_limit?: number | null }) => {
  if ('automatic_memory' in patch && typeof patch.automatic_memory !== 'boolean') throw new Error('bad_automatic_memory');
  if ('result_limit' in patch && patch.result_limit !== null && (!Number.isInteger(patch.result_limit) || patch.result_limit! < 1 || patch.result_limit! > 20)) throw new Error('bad_memory_result_limit');
  db.transaction(() => {
    const current = getMemoryPreferences(userId);
    db.prepare(`INSERT INTO user_memory_preferences (user_id, automatic_memory, result_limit) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET automatic_memory = excluded.automatic_memory, result_limit = excluded.result_limit`)
      .run(resolveAccountId(userId), (patch.automatic_memory ?? current.automatic_memory) ? 1 : 0,
        'result_limit' in patch ? patch.result_limit : current.result_limit);
  })();
  return getMemoryPreferences(userId);
};
export const resolveMemoryPreferences = (userId: number, chatId?: number) => {
  const user = getMemoryPreferences(userId);
  const chat = chatId === undefined ? null : getChatMemorySettings(userId, chatId);
  return {
    automaticMemory: chat?.automatic_memory_mode === 'enabled' || (chat?.automatic_memory_mode !== 'disabled' && user.automatic_memory),
    resultLimit: chat?.memory_result_limit ?? user.effective_result_limit,
    inheritedResultLimit: user.effective_result_limit,
    inheritedAutomaticMemory: user.automatic_memory,
  };
};
