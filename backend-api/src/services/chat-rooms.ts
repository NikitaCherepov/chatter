import { db } from '../db.js';
import {
  CUSTOM_PROMPT_ID,
  USER_PROMPT_OFFSET,
  getPromptById,
  getUserPromptById,
  parseUserPromptRowId,
  resolvePromptForUser,
  type PromptRecord,
} from './prompts.js';

export type ChatAgentDto = {
  id: number;
  chat_id: number;
  owner_user_id: number;
  source_prompt_id: number | null;
  name: string;
  prompt_content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ChatRoomDto = {
  enabled: boolean;
  response_mode: 'manual' | 'round';
  auto_respond: boolean;
  next_agent_id: number | null;
  agents: ChatAgentDto[];
};

export const getChatAgentForResponse = (
  userId: number,
  chatId: number,
  agentId: number,
): ChatAgentDto => {
  const chat = requireRoom(userId, chatId);
  const agent = db.prepare(`
    SELECT id, chat_id, owner_user_id, source_prompt_id, name, prompt_content,
           sort_order, created_at, updated_at
    FROM chat_agents
    WHERE id = ? AND chat_id = ? AND is_active = 1
  `).get(agentId, chat.id) as ChatAgentDto | undefined;
  if (!agent) throw new Error('agent_not_found');
  return agent;
};

export const hasMultipleActiveChatAgents = (userId: number, chatId: number): boolean => {
  const chat = requireRoom(userId, chatId);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_agents
    WHERE chat_id = ? AND is_active = 1
  `).get(chat.id) as { count: number };
  return Number(row.count) > 1;
};

type ChatRoomRow = {
  id: number;
  user_id: number;
  room_enabled: number;
  room_response_mode: string;
  room_auto_respond: number;
  room_next_agent_id: number | null;
};

const getOwnedChat = (userId: number, chatId: number) => db.prepare(`
  SELECT id, user_id, room_enabled, room_response_mode, room_auto_respond, room_next_agent_id
  FROM user_chats
  WHERE id = ? AND user_id = ?
`).get(chatId, userId) as ChatRoomRow | undefined;

const listActiveAgents = (chatId: number) => db.prepare(`
  SELECT id, chat_id, owner_user_id, source_prompt_id, name, prompt_content,
         sort_order, created_at, updated_at
  FROM chat_agents
  WHERE chat_id = ? AND is_active = 1
  ORDER BY sort_order ASC, id ASC
`).all(chatId) as ChatAgentDto[];

const toRoomDto = (chat: ChatRoomRow): ChatRoomDto => ({
  enabled: chat.room_enabled === 1,
  response_mode: chat.room_response_mode === 'round' ? 'round' : 'manual',
  auto_respond: chat.room_auto_respond === 1,
  next_agent_id: chat.room_next_agent_id,
  agents: listActiveAgents(chat.id),
});

const requireRoom = (userId: number, chatId: number) => {
  const chat = getOwnedChat(userId, chatId);
  if (!chat) throw new Error('chat_not_found');
  if (chat.room_enabled !== 1) throw new Error('room_not_created');
  return chat;
};

const getUserPromptSelection = (userId: number) => db.prepare(`
  SELECT id, selected_prompt_id, custom_prompt_content
  FROM users
  WHERE id = ?
`).get(userId) as { id: number; selected_prompt_id: number | null; custom_prompt_content: string | null } | undefined;

const resolvePromptSnapshot = (userId: number, selectedPromptId?: number): PromptRecord => {
  const user = getUserPromptSelection(userId);
  if (!user) throw new Error('user_not_found');
  if (selectedPromptId === undefined) return resolvePromptForUser(user);

  if (!Number.isSafeInteger(selectedPromptId) || selectedPromptId === 0) {
    throw new Error('bad_prompt_id');
  }
  if (selectedPromptId > 0) {
    const prompt = getPromptById(selectedPromptId);
    if (!prompt) throw new Error('prompt_not_found');
    return prompt;
  }
  if (selectedPromptId <= -USER_PROMPT_OFFSET) {
    const rowId = parseUserPromptRowId(selectedPromptId);
    const prompt = rowId === null ? undefined : getUserPromptById(userId, rowId);
    if (!prompt) throw new Error('prompt_not_found');
    return {
      id: selectedPromptId,
      name: prompt.name,
      description: prompt.description,
      content: prompt.content,
      is_default: 0,
    };
  }
  if (selectedPromptId === CUSTOM_PROMPT_ID && user.custom_prompt_content?.trim()) {
    return {
      id: CUSTOM_PROMPT_ID,
      name: 'Custom',
      description: 'User-defined prompt',
      content: user.custom_prompt_content.trim(),
      is_default: 0,
    };
  }
  throw new Error('prompt_not_found');
};

const normalizeAgentName = (value: unknown, fallback: string) => {
  const normalized = `${value ?? ''}`.trim().replace(/\s+/g, ' ').slice(0, 80);
  return normalized || fallback.trim().slice(0, 80) || 'Chatter';
};

const makeUniqueAgentName = (chatId: number, requestedName: string, excludeAgentId?: number) => {
  const names = new Set((db.prepare(`
    SELECT id, lower(name) AS name
    FROM chat_agents
    WHERE chat_id = ? AND is_active = 1
  `).all(chatId) as Array<{ id: number; name: string }>)
    .filter(row => row.id !== excludeAgentId)
    .map(row => row.name));
  if (!names.has(requestedName.toLowerCase())) return requestedName;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${requestedName} ${suffix}`.slice(0, 80);
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${requestedName.slice(0, 68)} ${Date.now()}`;
};

const compactAgentOrder = (chatId: number) => {
  const agents = db.prepare(`
    SELECT id FROM chat_agents
    WHERE chat_id = ? AND is_active = 1
    ORDER BY sort_order ASC, id ASC
  `).all(chatId) as Array<{ id: number }>;
  const update = db.prepare('UPDATE chat_agents SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  agents.forEach((agent, index) => update.run(index, agent.id));
};

export const getChatRoom = (userId: number, chatId: number): ChatRoomDto | null => {
  const chat = getOwnedChat(userId, chatId);
  return chat ? toRoomDto(chat) : null;
};

export const createChatRoom = (userId: number, chatId: number): ChatRoomDto => db.transaction(() => {
  const chat = getOwnedChat(userId, chatId);
  if (!chat) throw new Error('chat_not_found');
  if (chat.room_enabled === 1) return toRoomDto(chat);

  const prompt = resolvePromptSnapshot(userId);
  const name = makeUniqueAgentName(chatId, normalizeAgentName(prompt.name, 'Chatter'));
  const order = Number((db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
    FROM chat_agents WHERE chat_id = ? AND is_active = 1
  `).get(chatId) as { next_order: number }).next_order);
  const inserted = db.prepare(`
    INSERT INTO chat_agents (
      chat_id, owner_user_id, source_prompt_id, name, prompt_content, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(chatId, userId, prompt.id, name, prompt.content, order);
  const agentId = Number(inserted.lastInsertRowid);
  db.prepare(`
    UPDATE user_chats
    SET room_enabled = 1,
        room_response_mode = 'manual',
        room_auto_respond = 1,
        room_next_agent_id = ?,
        default_prompt_id = COALESCE(default_prompt_id, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(agentId, prompt.id, chatId, userId);
  return toRoomDto(getOwnedChat(userId, chatId)!);
})();

export const deleteChatRoom = (userId: number, chatId: number): ChatRoomDto => db.transaction(() => {
  const chat = requireRoom(userId, chatId);
  const activeCount = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM chat_agents WHERE chat_id = ? AND is_active = 1
  `).get(chatId) as { count: number }).count);
  if (activeCount > 0) throw new Error('room_has_agents');
  db.prepare(`
    UPDATE user_chats
    SET room_enabled = 0, room_next_agent_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(chatId, userId);
  return toRoomDto({ ...chat, room_enabled: 0, room_next_agent_id: null });
})();

export const addChatAgent = (
  userId: number,
  chatId: number,
  sourcePromptId: number,
  requestedName?: string,
): ChatRoomDto => db.transaction(() => {
  requireRoom(userId, chatId);
  const prompt = resolvePromptSnapshot(userId, sourcePromptId);
  const name = makeUniqueAgentName(chatId, normalizeAgentName(requestedName, prompt.name));
  const order = Number((db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
    FROM chat_agents WHERE chat_id = ? AND is_active = 1
  `).get(chatId) as { next_order: number }).next_order);
  const inserted = db.prepare(`
    INSERT INTO chat_agents (
      chat_id, owner_user_id, source_prompt_id, name, prompt_content, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(chatId, userId, prompt.id, name, prompt.content, order);
  db.prepare(`
    UPDATE user_chats
    SET room_next_agent_id = COALESCE(room_next_agent_id, ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(Number(inserted.lastInsertRowid), chatId, userId);
  return toRoomDto(getOwnedChat(userId, chatId)!);
})();

export const updateChatAgent = (
  userId: number,
  chatId: number,
  agentId: number,
  fields: { name?: string; promptContent?: string; sourcePromptId?: number },
): ChatRoomDto => db.transaction(() => {
  requireRoom(userId, chatId);
  const agent = db.prepare(`
    SELECT id, name FROM chat_agents WHERE id = ? AND chat_id = ? AND is_active = 1
  `).get(agentId, chatId) as { id: number; name: string } | undefined;
  if (!agent) throw new Error('agent_not_found');

  const updates: string[] = [];
  const params: Array<string | number | null> = [];
  if (fields.name !== undefined) {
    updates.push('name = ?');
    params.push(makeUniqueAgentName(chatId, normalizeAgentName(fields.name, agent.name), agentId));
  }
  if (fields.sourcePromptId !== undefined) {
    const prompt = resolvePromptSnapshot(userId, fields.sourcePromptId);
    updates.push('source_prompt_id = ?', 'prompt_content = ?');
    params.push(prompt.id, prompt.content);
  } else if (fields.promptContent !== undefined) {
    const content = fields.promptContent.trim();
    if (!content) throw new Error('prompt_content_required');
    updates.push('prompt_content = ?');
    params.push(content);
  }
  if (updates.length === 0) return toRoomDto(getOwnedChat(userId, chatId)!);
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(agentId, chatId);
  db.prepare(`UPDATE chat_agents SET ${updates.join(', ')} WHERE id = ? AND chat_id = ?`).run(...params);
  return toRoomDto(getOwnedChat(userId, chatId)!);
})();

export const removeChatAgent = (userId: number, chatId: number, agentId: number): ChatRoomDto => db.transaction(() => {
  requireRoom(userId, chatId);
  const removed = db.prepare(`
    UPDATE chat_agents
    SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND chat_id = ? AND is_active = 1
  `).run(agentId, chatId);
  if (removed.changes === 0) throw new Error('agent_not_found');
  compactAgentOrder(chatId);
  const firstAgent = db.prepare(`
    SELECT id FROM chat_agents
    WHERE chat_id = ? AND is_active = 1
    ORDER BY sort_order ASC, id ASC LIMIT 1
  `).get(chatId) as { id: number } | undefined;
  db.prepare(`
    UPDATE user_chats
    SET room_next_agent_id = CASE WHEN room_next_agent_id = ? THEN ? ELSE room_next_agent_id END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(agentId, firstAgent?.id ?? null, chatId, userId);
  return toRoomDto(getOwnedChat(userId, chatId)!);
})();

export const reorderChatAgents = (userId: number, chatId: number, agentIds: number[]): ChatRoomDto => db.transaction(() => {
  requireRoom(userId, chatId);
  const activeIds = listActiveAgents(chatId).map(agent => agent.id);
  if (agentIds.length !== activeIds.length || new Set(agentIds).size !== agentIds.length) {
    throw new Error('bad_agent_order');
  }
  const expected = new Set(activeIds);
  if (agentIds.some(id => !expected.has(id))) throw new Error('bad_agent_order');
  const update = db.prepare('UPDATE chat_agents SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND chat_id = ?');
  agentIds.forEach((agentId, index) => update.run(index, agentId, chatId));
  return toRoomDto(getOwnedChat(userId, chatId)!);
})();

export const updateChatRoomSettings = (
  userId: number,
  chatId: number,
  fields: { responseMode?: 'manual' | 'round'; autoRespond?: boolean; nextAgentId?: number | null },
): ChatRoomDto => db.transaction(() => {
  requireRoom(userId, chatId);
  const updates: string[] = [];
  const params: Array<string | number | null> = [];
  if (fields.responseMode !== undefined) {
    updates.push('room_response_mode = ?');
    params.push(fields.responseMode);
  }
  if (fields.autoRespond !== undefined) {
    updates.push('room_auto_respond = ?');
    params.push(fields.autoRespond ? 1 : 0);
  }
  if (fields.nextAgentId !== undefined) {
    if (fields.nextAgentId !== null) {
      const exists = db.prepare(`
        SELECT id FROM chat_agents WHERE id = ? AND chat_id = ? AND is_active = 1
      `).get(fields.nextAgentId, chatId);
      if (!exists) throw new Error('agent_not_found');
    }
    updates.push('room_next_agent_id = ?');
    params.push(fields.nextAgentId);
  }
  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(chatId, userId);
    db.prepare(`UPDATE user_chats SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  }
  return toRoomDto(getOwnedChat(userId, chatId)!);
})();
