import { randomUUID } from 'node:crypto';
import { db, getNowUnix } from '../db.js';
import { resolveAccountId } from './accounts.js';

export type MemoryMode = 'off' | 'general' | 'chat' | 'both';
export type MemoryWriteTarget = 'general' | 'chat';

export type Persona = {
  id: number;
  user_id: number;
  name: string;
  description: string;
  core_memory: string;
  allow_core_memory_update: number;
  is_primary: number;
  is_default: number;
  created_at: number;
  updated_at: number;
};

export type MemorySpace = {
  id: number;
  user_id: number;
  name: string;
  kind: 'general' | 'chat';
  chat_id: number | null;
  namespace_key: string;
  is_default: number;
  is_primary: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ChatMemorySettings = {
  user_id: number;
  chat_id: number;
  persona_id: number;
  persona_override_id: number | null;
  general_space_id: number;
  chat_space_id: number | null;
  memory_mode: MemoryMode;
  write_target: MemoryWriteTarget;
  use_core_memory: number;
  allow_core_memory_update: number;
  created_at: number;
  updated_at: number;
};

export type MemoryRecord = {
  id: string;
  user_id: number;
  memory_space_id: number;
  text: string;
  source: string;
  origin_message_cursor: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

const canonicalUserId = (userId: number) => resolveAccountId(Math.floor(userId));

const requireUser = (userId: number) => {
  const accountId = canonicalUserId(userId);
  const user = db.prepare('SELECT id, name, core_memory FROM users WHERE id = ?')
    .get(accountId) as { id: number; name: string | null; core_memory: string | null } | undefined;
  if (!user) throw new Error('user_not_found');
  return user;
};

export const canAccessChat = (userId: number, chatId: number) => {
  const accountId = canonicalUserId(userId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM user_chats c
    WHERE c.id = ?
      AND (
        c.user_id = ?
        OR EXISTS (
          SELECT 1 FROM chat_members m
          WHERE m.chat_id = c.id AND m.user_id = ?
        )
      )
  `).get(chatId, accountId, accountId));
};

const requireChatAccess = (userId: number, chatId: number) => {
  const accountId = canonicalUserId(userId);
  if (!canAccessChat(accountId, chatId)) throw new Error('chat_not_found');
  return accountId;
};

export const ensureMemoryDefaults = (userId: number): { persona: Persona; space: MemorySpace } => {
  const user = requireUser(userId);
  return db.transaction(() => {
    const now = getNowUnix();
    let persona = db.prepare(`
      SELECT * FROM personas WHERE user_id = ? AND is_default = 1 LIMIT 1
    `).get(user.id) as Persona | undefined;
    if (!persona) {
      persona = db.prepare('SELECT * FROM personas WHERE user_id = ? AND is_primary = 1 LIMIT 1')
        .get(user.id) as Persona | undefined;
      if (persona) {
        db.prepare('UPDATE personas SET is_default = 1, updated_at = ? WHERE id = ?').run(now, persona.id);
        persona = { ...persona, is_default: 1, updated_at: now };
      } else {
        const inserted = db.prepare(`
          INSERT INTO personas (user_id, name, description, core_memory, allow_core_memory_update, is_primary, is_default, created_at, updated_at)
          VALUES (?, ?, '', ?, 1, 1, 1, ?, ?)
        `).run(user.id, `${user.name || 'User'}`.trim().slice(0, 80) || 'User', `${user.core_memory || ''}`.slice(0, 800), now, now);
        persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(inserted.lastInsertRowid)) as Persona;
      }
    }

    let space = db.prepare(`
      SELECT * FROM memory_spaces
      WHERE user_id = ? AND kind = 'general' AND is_default = 1 AND archived_at IS NULL
      LIMIT 1
    `).get(user.id) as MemorySpace | undefined;
    if (!space) {
      const inserted = db.prepare(`
        INSERT INTO memory_spaces (
          user_id, name, kind, chat_id, namespace_key, is_default, is_primary, created_at, updated_at
        ) VALUES (?, 'Main memory', 'general', NULL, ?, 1, 1, ?, ?)
      `).run(user.id, `${user.id}`, now, now);
      space = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(Number(inserted.lastInsertRowid)) as MemorySpace;
    }
    return { persona, space };
  })();
};

export const listPersonas = (userId: number): Persona[] => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  return db.prepare('SELECT * FROM personas WHERE user_id = ? ORDER BY is_primary DESC, is_default DESC, id ASC')
    .all(accountId) as Persona[];
};

export const createPersona = (
  userId: number,
  name: string,
  description = '',
  coreMemory = '',
  allowCoreMemoryUpdate = true,
): Persona => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  const safeName = `${name || ''}`.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!safeName) throw new Error('persona_name_required');
  const now = getNowUnix();
  const inserted = db.prepare(`
    INSERT INTO personas (user_id, name, description, core_memory, allow_core_memory_update, is_primary, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(accountId, safeName, `${description || ''}`.trim().slice(0, 240), `${coreMemory || ''}`.slice(0, 800), allowCoreMemoryUpdate ? 1 : 0, now, now);
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(inserted.lastInsertRowid)) as Persona;
};

export const updatePersona = (
  userId: number,
  personaId: number,
  patch: { name?: string; description?: string; core_memory?: string; allow_core_memory_update?: number },
): Persona => {
  const accountId = canonicalUserId(userId);
  const persona = db.prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
    .get(personaId, accountId) as Persona | undefined;
  if (!persona) throw new Error('persona_not_found');
  const name = persona.is_primary === 1 || patch.name === undefined
    ? persona.name
    : `${patch.name}`.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw new Error('persona_name_required');
  const coreMemory = patch.core_memory === undefined
    ? persona.core_memory
    : `${patch.core_memory}`.slice(0, 800);
  const description = patch.description === undefined
    ? persona.description
    : `${patch.description}`.trim().slice(0, 240);
  const allowCoreMemoryUpdate = patch.allow_core_memory_update === undefined
    ? persona.allow_core_memory_update
    : patch.allow_core_memory_update ? 1 : 0;
  db.prepare(`
    UPDATE personas SET name = ?, description = ?, core_memory = ?, allow_core_memory_update = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(name, description, coreMemory, allowCoreMemoryUpdate, getNowUnix(), personaId, accountId);
  if (persona.is_primary === 1) {
    db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(coreMemory, accountId);
  }
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(personaId) as Persona;
};

export const setActivePersona = (userId: number, personaId: number): Persona => {
  const accountId = canonicalUserId(userId);
  const persona = db.prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
    .get(personaId, accountId) as Persona | undefined;
  if (!persona) throw new Error('persona_not_found');
  db.transaction(() => {
    db.prepare('UPDATE personas SET is_default = 0, updated_at = ? WHERE user_id = ? AND is_default = 1')
      .run(getNowUnix(), accountId);
    db.prepare('UPDATE personas SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(getNowUnix(), personaId, accountId);
  })();
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(personaId) as Persona;
};

export const deletePersona = (userId: number, personaId: number) => {
  const accountId = canonicalUserId(userId);
  const persona = db.prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
    .get(personaId, accountId) as Persona | undefined;
  if (!persona) throw new Error('persona_not_found');
  if (persona.is_primary === 1) throw new Error('primary_persona_cannot_be_deleted');
  db.transaction(() => {
    db.prepare('UPDATE chat_memory_settings SET persona_override_id = NULL, updated_at = ? WHERE user_id = ? AND persona_override_id = ?')
      .run(getNowUnix(), accountId, personaId);
    db.prepare('DELETE FROM personas WHERE id = ? AND user_id = ?').run(personaId, accountId);
    if (persona.is_default === 1) {
      const replacement = db.prepare('SELECT * FROM personas WHERE user_id = ? ORDER BY id ASC LIMIT 1')
        .get(accountId) as Persona | undefined;
      if (replacement) {
        db.prepare('UPDATE personas SET is_default = 1, updated_at = ? WHERE id = ?').run(getNowUnix(), replacement.id);
        db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(replacement.core_memory, accountId);
      }
    }
  })();
  return ensureMemoryDefaults(accountId).persona;
};

export const listMemorySpaces = (userId: number): MemorySpace[] => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  return db.prepare(`
    SELECT * FROM memory_spaces
    WHERE user_id = ? AND archived_at IS NULL
    ORDER BY is_default DESC, kind ASC, name COLLATE NOCASE ASC, id ASC
  `).all(accountId) as MemorySpace[];
};

export const listChatMemorySpacesForDeletion = (ownerUserId: number, chatId: number): MemorySpace[] => {
  const accountId = canonicalUserId(ownerUserId);
  const ownsChat = db.prepare('SELECT 1 FROM user_chats WHERE id = ? AND user_id = ?')
    .get(chatId, accountId);
  if (!ownsChat) throw new Error('chat_not_found');
  return db.prepare(`
    SELECT * FROM memory_spaces
    WHERE chat_id = ? AND kind = 'chat'
    ORDER BY user_id ASC, id ASC
  `).all(chatId) as MemorySpace[];
};

export const purgeCanonicalChatMemory = (ownerUserId: number, chatId: number) => {
  const spaces = listChatMemorySpacesForDeletion(ownerUserId, chatId);
  const spaceIds = spaces.map(space => space.id);
  return db.transaction(() => {
    if (spaceIds.length > 0) {
      const placeholders = spaceIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM memory_chunks WHERE memory_space_id IN (${placeholders})`)
        .run(...spaceIds);
      db.prepare(`DELETE FROM memory_records WHERE memory_space_id IN (${placeholders})`)
        .run(...spaceIds);
      db.prepare(`DELETE FROM memory_spaces WHERE id IN (${placeholders}) AND chat_id = ?`)
        .run(...spaceIds, chatId);
    }
    db.prepare('DELETE FROM chat_memory_settings WHERE chat_id = ?').run(chatId);
    return { spaces_deleted: spaces.length };
  })();
};

export const createGeneralMemorySpace = (userId: number, name: string): MemorySpace => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  const safeName = `${name || ''}`.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!safeName) throw new Error('memory_space_name_required');
  const now = getNowUnix();
  const inserted = db.prepare(`
    INSERT INTO memory_spaces (
      user_id, name, kind, chat_id, namespace_key, is_default, created_at, updated_at
    ) VALUES (?, ?, 'general', NULL, ?, 0, ?, ?)
  `).run(accountId, safeName, `account-${accountId}-general-${randomUUID()}`, now, now);
  return db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(Number(inserted.lastInsertRowid)) as MemorySpace;
};

export const renameGeneralMemorySpace = (userId: number, spaceId: number, name: string): MemorySpace => {
  const accountId = canonicalUserId(userId);
  const safeName = `${name || ''}`.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!safeName) throw new Error('memory_space_name_required');
  const result = db.prepare(`
    UPDATE memory_spaces SET name = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
  `).run(safeName, getNowUnix(), spaceId, accountId);
  if (result.changes === 0) throw new Error('memory_space_not_found');
  return db.prepare('SELECT * FROM memory_spaces WHERE id = ? AND user_id = ?')
    .get(spaceId, accountId) as MemorySpace;
};

export const archiveGeneralMemorySpace = (userId: number, spaceId: number): MemorySpace => {
  const accountId = canonicalUserId(userId);
  const defaults = ensureMemoryDefaults(accountId);
  const space = db.prepare(`
    SELECT * FROM memory_spaces
    WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
  `).get(spaceId, accountId) as MemorySpace | undefined;
  if (!space) throw new Error('memory_space_not_found');
  if (space.is_primary === 1) throw new Error('primary_memory_space_cannot_be_deleted');
  const primary = db.prepare(`
    SELECT * FROM memory_spaces
    WHERE user_id = ? AND kind = 'general' AND is_primary = 1 AND archived_at IS NULL
    LIMIT 1
  `).get(accountId) as MemorySpace | undefined || defaults.space;
  const now = getNowUnix();
  db.transaction(() => {
    db.prepare('DELETE FROM memory_chunks WHERE user_id = ? AND memory_space_id = ?').run(accountId, space.id);
    db.prepare(`
      UPDATE memory_records SET deleted_at = ?, updated_at = ?
      WHERE user_id = ? AND memory_space_id = ? AND deleted_at IS NULL
    `).run(now, now, accountId, space.id);
    db.prepare(`
      UPDATE memory_spaces SET archived_at = ?, is_default = 0, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(now, now, space.id, accountId);
    if (space.is_default === 1) {
      db.prepare("UPDATE memory_spaces SET is_default = 0, updated_at = ? WHERE user_id = ? AND kind = 'general'")
        .run(now, accountId);
      db.prepare('UPDATE memory_spaces SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(now, primary.id, accountId);
    }
    db.prepare(`
      UPDATE chat_memory_settings SET general_space_id = ?, updated_at = ?
      WHERE user_id = ? AND general_space_id = ?
    `).run(primary.id, now, accountId, space.id);
  })();
  return db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(primary.id) as MemorySpace;
};

export const setDefaultGeneralMemorySpace = (userId: number, spaceId: number): MemorySpace => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  const space = db.prepare(`
    SELECT * FROM memory_spaces
    WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
  `).get(spaceId, accountId) as MemorySpace | undefined;
  if (!space) throw new Error('memory_space_not_found');
  const now = getNowUnix();
  db.transaction(() => {
    db.prepare("UPDATE memory_spaces SET is_default = 0, updated_at = ? WHERE user_id = ? AND kind = 'general' AND is_default = 1")
      .run(now, accountId);
    db.prepare('UPDATE memory_spaces SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(now, spaceId, accountId);
    db.prepare('UPDATE chat_memory_settings SET general_space_id = ?, updated_at = ? WHERE user_id = ?')
      .run(spaceId, now, accountId);
  })();
  return db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(spaceId) as MemorySpace;
};

const ensureChatMemorySpace = (userId: number, chatId: number): MemorySpace => {
  const accountId = requireChatAccess(userId, chatId);
  let space = db.prepare(`
    SELECT * FROM memory_spaces
    WHERE user_id = ? AND chat_id = ? AND kind = 'chat'
    LIMIT 1
  `).get(accountId, chatId) as MemorySpace | undefined;
  if (space) {
    if (space.archived_at !== null) {
      db.prepare('UPDATE memory_spaces SET archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(getNowUnix(), space.id, accountId);
      space = db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(space.id) as MemorySpace;
    }
    return space;
  }
  const now = getNowUnix();
  const inserted = db.prepare(`
    INSERT INTO memory_spaces (
      user_id, name, kind, chat_id, namespace_key, is_default, created_at, updated_at
    ) VALUES (?, ?, 'chat', ?, ?, 0, ?, ?)
  `).run(accountId, `Chat ${chatId}`, chatId, `account-${accountId}-chat-${chatId}`, now, now);
  return db.prepare('SELECT * FROM memory_spaces WHERE id = ?').get(Number(inserted.lastInsertRowid)) as MemorySpace;
};

export const getChatMemorySettings = (userId: number, chatId: number): ChatMemorySettings => {
  const accountId = requireChatAccess(userId, chatId);
  const defaults = ensureMemoryDefaults(accountId);
  const now = getNowUnix();
  db.prepare(`
    INSERT OR IGNORE INTO chat_memory_settings (
      user_id, chat_id, persona_id, persona_override_id, general_space_id, chat_space_id,
      memory_mode, write_target, use_core_memory, allow_core_memory_update,
      created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, NULL, 'general', 'general', 1, 1, ?, ?)
  `).run(accountId, chatId, defaults.persona.id, defaults.space.id, now, now);
  let settings = db.prepare(`
    SELECT * FROM chat_memory_settings WHERE user_id = ? AND chat_id = ?
  `).get(accountId, chatId) as ChatMemorySettings;
  const normalizedTarget = settings.memory_mode === 'chat'
    ? 'chat'
    : settings.memory_mode === 'off' || settings.memory_mode === 'general'
      ? 'general'
      : settings.write_target;
  if (normalizedTarget !== settings.write_target) {
    db.prepare('UPDATE chat_memory_settings SET write_target = ?, updated_at = ? WHERE user_id = ? AND chat_id = ?')
      .run(normalizedTarget, now, accountId, chatId);
    settings = { ...settings, write_target: normalizedTarget, updated_at: now };
  }
  return settings;
};

export const updateChatMemorySettings = (
  userId: number,
  chatId: number,
  patch: Partial<Pick<ChatMemorySettings,
    'persona_override_id' | 'memory_mode' | 'write_target' |
    'use_core_memory' | 'allow_core_memory_update'>>,
): ChatMemorySettings => {
  const accountId = requireChatAccess(userId, chatId);
  const current = getChatMemorySettings(accountId, chatId);
  const personaOverrideId = patch.persona_override_id === undefined
    ? current.persona_override_id
    : patch.persona_override_id;
  const generalSpaceId = ensureMemoryDefaults(accountId).space.id;
  const memoryMode = patch.memory_mode ?? current.memory_mode;
  let writeTarget = patch.write_target ?? current.write_target;
  if (!['off', 'general', 'chat', 'both'].includes(memoryMode)) throw new Error('bad_memory_mode');
  if (!['general', 'chat'].includes(writeTarget)) throw new Error('bad_write_target');
  if (personaOverrideId !== null && !db.prepare('SELECT 1 FROM personas WHERE id = ? AND user_id = ?').get(personaOverrideId, accountId)) {
    throw new Error('persona_not_found');
  }
  if (!db.prepare(`
    SELECT 1 FROM memory_spaces
    WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
  `).get(generalSpaceId, accountId)) {
    throw new Error('memory_space_not_found');
  }
  let chatSpaceId = current.chat_space_id;
  if (memoryMode === 'chat' || memoryMode === 'both' || writeTarget === 'chat') {
    chatSpaceId = ensureChatMemorySpace(accountId, chatId).id;
  }
  if (memoryMode === 'off' || memoryMode === 'general') writeTarget = 'general';
  if (memoryMode === 'chat') writeTarget = 'chat';
  const useCoreMemory = patch.use_core_memory === undefined
    ? current.use_core_memory
    : patch.use_core_memory ? 1 : 0;
  const allowCoreMemoryUpdate = patch.allow_core_memory_update === undefined
    ? current.allow_core_memory_update
    : patch.allow_core_memory_update ? 1 : 0;
  db.prepare(`
    UPDATE chat_memory_settings
    SET persona_override_id = ?, general_space_id = ?, chat_space_id = ?, memory_mode = ?,
        write_target = ?, use_core_memory = ?, allow_core_memory_update = ?, updated_at = ?
    WHERE user_id = ? AND chat_id = ?
  `).run(
    personaOverrideId, generalSpaceId, chatSpaceId, memoryMode, writeTarget,
    useCoreMemory, allowCoreMemoryUpdate, getNowUnix(), accountId, chatId,
  );
  return getChatMemorySettings(accountId, chatId);
};

export const resolvePersonaForChat = (userId: number, chatId?: number | null) => {
  const accountId = canonicalUserId(userId);
  const defaults = ensureMemoryDefaults(accountId);
  if (!chatId) {
    return { persona: defaults.persona, useCoreMemory: true, allowCoreMemoryUpdate: defaults.persona.allow_core_memory_update === 1 };
  }
  const settings = getChatMemorySettings(accountId, chatId);
  const persona = settings.persona_override_id === null
    ? defaults.persona
    : db.prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
      .get(settings.persona_override_id, accountId) as Persona | undefined;
  return {
    persona: persona || defaults.persona,
    useCoreMemory: true,
    allowCoreMemoryUpdate: (persona || defaults.persona).allow_core_memory_update === 1,
  };
};

export const resolveReadMemorySpaces = (userId: number, chatId?: number | null): MemorySpace[] => {
  const accountId = canonicalUserId(userId);
  const defaults = ensureMemoryDefaults(accountId);
  if (!chatId) return [defaults.space];
  const settings = getChatMemorySettings(accountId, chatId);
  if (settings.memory_mode === 'off') return [];
  const ids: number[] = [];
  if (settings.memory_mode === 'general' || settings.memory_mode === 'both') ids.push(settings.general_space_id);
  if ((settings.memory_mode === 'chat' || settings.memory_mode === 'both') && settings.chat_space_id) {
    ids.push(settings.chat_space_id);
  }
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM memory_spaces
    WHERE user_id = ? AND archived_at IS NULL AND id IN (${placeholders})
  `).all(accountId, ...ids) as MemorySpace[];
};

export const resolveWriteMemorySpace = (userId: number, chatId?: number | null): MemorySpace => {
  const accountId = canonicalUserId(userId);
  const defaults = ensureMemoryDefaults(accountId);
  if (!chatId) return defaults.space;
  const settings = getChatMemorySettings(accountId, chatId);
  if (settings.write_target === 'chat') return ensureChatMemorySpace(accountId, chatId);
  return db.prepare(`
    SELECT * FROM memory_spaces WHERE id = ? AND user_id = ? AND archived_at IS NULL
  `).get(settings.general_space_id, accountId) as MemorySpace || defaults.space;
};

export const createMemoryRecord = (input: {
  id: string;
  userId: number;
  spaceId: number;
  text: string;
  source: string;
  originMessageCursor?: number | null;
  chunks: Array<{ id: string; text: string; index: number }>;
  createdAt?: number;
}) => db.transaction(() => {
  const accountId = canonicalUserId(input.userId);
  const space = db.prepare('SELECT 1 FROM memory_spaces WHERE id = ? AND user_id = ?')
    .get(input.spaceId, accountId);
  if (!space) throw new Error('memory_space_not_found');
  const now = input.createdAt || getNowUnix();
  db.prepare(`
    INSERT INTO memory_records (
      id, user_id, memory_space_id, text, source, origin_message_cursor, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, accountId, input.spaceId, input.text, input.source,
    input.originMessageCursor ?? null, now, now,
  );
  const insertChunk = db.prepare(`
    INSERT INTO memory_chunks (
      id, memory_record_id, user_id, memory_space_id, text,
      chunk_index, total_chunks, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  input.chunks.forEach(chunk => insertChunk.run(
    chunk.id, input.id, accountId, input.spaceId, chunk.text,
    chunk.index, input.chunks.length, now, now,
  ));
})();

export type ForkableMemoryRecord = {
  record: MemoryRecord;
  chunks: Array<{
    id: string;
    text: string;
    index: number;
  }>;
};

export type ChatMemoryForkPlan = {
  sourceSpace: MemorySpace | null;
  targetSpace: MemorySpace | null;
  records: ForkableMemoryRecord[];
};

/**
 * Copy chat-level memory settings and prepare a separate chat memory space for
 * a fork. General memory is referenced, never duplicated. Records with a NULL
 * cursor are manual/legacy memories and intentionally follow the branch.
 */
export const initializeForkedChatMemory = (
  userId: number,
  sourceChatId: number,
  targetChatId: number,
  anchorTimelineIndex: number,
): ChatMemoryForkPlan => {
  const accountId = requireChatAccess(userId, sourceChatId);
  requireChatAccess(accountId, targetChatId);
  const sourceSettings = db.prepare(`
    SELECT * FROM chat_memory_settings WHERE user_id = ? AND chat_id = ?
  `).get(accountId, sourceChatId) as ChatMemorySettings | undefined;
  if (!sourceSettings) return { sourceSpace: null, targetSpace: null, records: [] };

  return db.transaction(() => {
    const sourceSpace = sourceSettings.chat_space_id === null
      ? null
      : db.prepare(`
          SELECT * FROM memory_spaces
          WHERE id = ? AND user_id = ? AND kind = 'chat' AND chat_id = ? AND archived_at IS NULL
        `).get(sourceSettings.chat_space_id, accountId, sourceChatId) as MemorySpace | undefined;
    const targetSpace = sourceSpace ? ensureChatMemorySpace(accountId, targetChatId) : null;
    const now = getNowUnix();
    db.prepare(`
      INSERT INTO chat_memory_settings (
        user_id, chat_id, persona_id, persona_override_id, general_space_id, chat_space_id,
        memory_mode, write_target, use_core_memory, allow_core_memory_update, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, chat_id) DO UPDATE SET
        persona_id = excluded.persona_id,
        persona_override_id = excluded.persona_override_id,
        general_space_id = excluded.general_space_id,
        chat_space_id = excluded.chat_space_id,
        memory_mode = excluded.memory_mode,
        write_target = excluded.write_target,
        use_core_memory = excluded.use_core_memory,
        allow_core_memory_update = excluded.allow_core_memory_update,
        updated_at = excluded.updated_at
    `).run(
      accountId, targetChatId, sourceSettings.persona_id, sourceSettings.persona_override_id,
      sourceSettings.general_space_id, targetSpace?.id ?? null, sourceSettings.memory_mode,
      sourceSettings.write_target, sourceSettings.use_core_memory,
      sourceSettings.allow_core_memory_update, now, now,
    );

    if (!sourceSpace || !targetSpace) {
      return { sourceSpace: sourceSpace ?? null, targetSpace, records: [] };
    }
    const records = db.prepare(`
      SELECT * FROM memory_records
      WHERE user_id = ? AND memory_space_id = ? AND deleted_at IS NULL
        AND (origin_message_cursor IS NULL OR origin_message_cursor <= ?)
      ORDER BY created_at ASC, id ASC
    `).all(accountId, sourceSpace.id, anchorTimelineIndex) as MemoryRecord[];
    return {
      sourceSpace,
      targetSpace,
      records: records.map(record => ({
        record,
        chunks: (db.prepare(`
          SELECT id, text, chunk_index FROM memory_chunks
          WHERE user_id = ? AND memory_record_id = ?
          ORDER BY chunk_index ASC
        `).all(accountId, record.id) as Array<{ id: string; text: string; chunk_index: number }>).map(chunk => ({
          id: chunk.id,
          text: chunk.text,
          index: chunk.chunk_index,
        })),
      })),
    };
  })();
};

export const listMemoryRecords = (
  userId: number,
  spaceId?: number,
  limit = 100,
  offset = 0,
): MemoryRecord[] => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 100));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  if (spaceId !== undefined) {
    return db.prepare(`
      SELECT r.* FROM memory_records r
      JOIN memory_spaces s ON s.id = r.memory_space_id
      WHERE r.user_id = ? AND r.memory_space_id = ? AND s.user_id = ? AND r.deleted_at IS NULL
      ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?
    `).all(accountId, spaceId, accountId, safeLimit, safeOffset) as MemoryRecord[];
  }
  return db.prepare(`
    SELECT * FROM memory_records
    WHERE user_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(accountId, safeLimit, safeOffset) as MemoryRecord[];
};

export const listChatMemoryRecords = (userId: number, chatId: number): MemoryRecord[] => {
  const settings = getChatMemorySettings(userId, chatId);
  if (!settings.chat_space_id) return [];
  return listMemoryRecords(userId, settings.chat_space_id);
};

export const listGeneralMemoryRecords = (userId: number, spaceId?: number): MemoryRecord[] => {
  const accountId = canonicalUserId(userId);
  const defaults = ensureMemoryDefaults(accountId);
  const targetSpaceId = spaceId ?? defaults.space.id;
  if (!db.prepare(`
    SELECT 1 FROM memory_spaces
    WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
  `).get(targetSpaceId, accountId)) throw new Error('memory_space_not_found');
  return listMemoryRecords(accountId, targetSpaceId);
};

export const requireChatMemoryRecord = (userId: number, chatId: number, recordId: string): MemoryRecord => {
  const settings = getChatMemorySettings(userId, chatId);
  const record = getOwnedMemoryRecord(userId, recordId);
  if (!record || !settings.chat_space_id || record.memory_space_id !== settings.chat_space_id) {
    throw new Error('memory_record_not_found');
  }
  return record;
};

export const requireGeneralMemoryRecord = (userId: number, recordId: string): MemoryRecord => {
  const accountId = canonicalUserId(userId);
  const record = getOwnedMemoryRecord(accountId, recordId);
  if (!record || !db.prepare(`
    SELECT 1 FROM memory_spaces
    WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
  `).get(record.memory_space_id, accountId)) throw new Error('memory_record_not_found');
  return record;
};

export const getOwnedMemoryRecord = (userId: number, recordId: string): MemoryRecord | undefined => {
  const accountId = canonicalUserId(userId);
  return db.prepare(`
    SELECT r.* FROM memory_records r
    JOIN memory_spaces s ON s.id = r.memory_space_id
    WHERE r.id = ? AND r.user_id = ? AND s.user_id = ? AND r.deleted_at IS NULL
  `).get(recordId, accountId, accountId) as MemoryRecord | undefined;
};

export const getRecordChunks = (userId: number, recordId: string) => {
  const accountId = canonicalUserId(userId);
  return db.prepare(`
    SELECT * FROM memory_chunks
    WHERE user_id = ? AND memory_record_id = ?
    ORDER BY chunk_index ASC
  `).all(accountId, recordId) as Array<{
    id: string;
    memory_record_id: string;
    user_id: number;
    memory_space_id: number;
    text: string;
    chunk_index: number;
    total_chunks: number;
  }>;
};

export const removeCanonicalMemoryRecord = (userId: number, recordId: string) => db.transaction(() => {
  const accountId = canonicalUserId(userId);
  const record = getOwnedMemoryRecord(accountId, recordId);
  if (!record) throw new Error('memory_record_not_found');
  const chunks = getRecordChunks(accountId, recordId);
  db.prepare('DELETE FROM memory_chunks WHERE memory_record_id = ? AND user_id = ?').run(recordId, accountId);
  db.prepare('UPDATE memory_records SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(getNowUnix(), getNowUnix(), recordId, accountId);
  return { record, chunks };
})();

export const setPersonaCoreMemory = (userId: number, personaId: number, content: string) => {
  const accountId = canonicalUserId(userId);
  const persona = db.prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
    .get(personaId, accountId) as Persona | undefined;
  if (!persona) throw new Error('persona_not_found');
  const safeContent = `${content || ''}`.slice(0, 800);
  db.prepare('UPDATE personas SET core_memory = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(safeContent, getNowUnix(), personaId, accountId);
  if (persona.is_primary === 1) {
    db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(safeContent, accountId);
  }
};

export const getPrimaryPersona = (userId: number) => {
  const accountId = canonicalUserId(userId);
  ensureMemoryDefaults(accountId);
  return db.prepare('SELECT * FROM personas WHERE user_id = ? AND is_primary = 1 LIMIT 1')
    .get(accountId) as Persona;
};

export const syncPrimaryPersonaName = (userId: number, name: string) => {
  const accountId = canonicalUserId(userId);
  const primary = getPrimaryPersona(accountId);
  const safeName = `${name || ''}`.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!safeName) throw new Error('persona_name_required');
  db.prepare('UPDATE personas SET name = ?, updated_at = ? WHERE id = ? AND user_id = ? AND is_primary = 1')
    .run(safeName, getNowUnix(), primary.id, accountId);
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(primary.id) as Persona;
};
