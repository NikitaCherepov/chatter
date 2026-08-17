import { db, getNowUnix } from '../db.js';
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
  access: 'private' | 'shared';
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ChatMemberDto = {
  user_id: number;
  name: string | null;
  role: 'admin' | 'member';
  response_mode: 'manual' | 'round';
  auto_respond: boolean;
  next_agent_id: number | null;
  sort_order: number;
  joined_at: string;
};

export type ChatRoomDto = {
  enabled: boolean;
  response_mode: 'manual' | 'round';
  auto_respond: boolean;
  next_agent_id: number | null;
  agents: ChatAgentDto[];
  members: ChatMemberDto[];
};

export const getChatAgentForResponse = (
  userId: number,
  chatId: number,
  agentId: number,
): ChatAgentDto => {
  const { chat } = requireRoom(userId, chatId);
  const agent = db.prepare(`
    SELECT id, chat_id, owner_user_id, source_prompt_id, name, prompt_content,
           access, sort_order, created_at, updated_at
    FROM chat_agents
    WHERE id = ? AND chat_id = ? AND is_active = 1
  `).get(agentId, chat.id) as ChatAgentDto | undefined;
  if (!agent) throw new Error('agent_not_found');
  return agent;
};

export const hasMultipleActiveChatAgents = (userId: number, chatId: number): boolean => {
  const { chat } = requireRoom(userId, chatId);
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
};

type ChatMemberRow = {
  chat_id: number;
  user_id: number;
  name: string | null;
  role: string;
  response_mode: string;
  auto_respond: number;
  next_agent_id: number | null;
  sort_order: number;
  joined_at: string;
};

const getOwnedChat = (userId: number, chatId: number) => db.prepare(`
  SELECT id, user_id, room_enabled
  FROM user_chats
  WHERE id = ? AND user_id = ?
`).get(chatId, userId) as ChatRoomRow | undefined;

/** Chat the user can see: either owned or a member of. */
export const getAccessibleChat = (userId: number, chatId: number): ChatRoomRow | undefined => {
  const owned = getOwnedChat(userId, chatId);
  if (owned) return owned;
  const membership = db.prepare('SELECT chat_id FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId) as { chat_id: number } | undefined;
  if (!membership) return undefined;
  return db.prepare('SELECT id, user_id, room_enabled FROM user_chats WHERE id = ?')
    .get(chatId) as ChatRoomRow | undefined;
};

const getMember = (chatId: number, userId: number) => db.prepare(`
  SELECT m.chat_id, m.user_id, u.name, m.role, m.response_mode, m.auto_respond, m.next_agent_id, m.sort_order, m.joined_at
  FROM chat_members m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE m.chat_id = ? AND m.user_id = ?
`).get(chatId, userId) as ChatMemberRow | undefined;

const listMembers = (chatId: number) => db.prepare(`
  SELECT m.chat_id, m.user_id, u.name, m.role, m.response_mode, m.auto_respond, m.next_agent_id, m.sort_order, m.joined_at
  FROM chat_members m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE m.chat_id = ?
  ORDER BY m.sort_order ASC, m.user_id ASC
`).all(chatId) as ChatMemberRow[];

const listActiveAgents = (chatId: number) => db.prepare(`
  SELECT id, chat_id, owner_user_id, source_prompt_id, name, prompt_content,
         access, sort_order, created_at, updated_at
  FROM chat_agents
  WHERE chat_id = ? AND is_active = 1
  ORDER BY sort_order ASC, id ASC
`).all(chatId) as ChatAgentDto[];

const toMemberDto = (member: ChatMemberRow): ChatMemberDto => ({
  user_id: member.user_id,
  name: member.name,
  role: member.role === 'admin' ? 'admin' : 'member',
  response_mode: member.response_mode === 'round' ? 'round' : 'manual',
  auto_respond: member.auto_respond === 1,
  next_agent_id: member.next_agent_id,
  sort_order: member.sort_order,
  joined_at: member.joined_at,
});

const toRoomDto = (chat: ChatRoomRow, viewerMember: ChatMemberRow | null): ChatRoomDto => ({
  enabled: chat.room_enabled === 1,
  response_mode: viewerMember?.response_mode === 'round' ? 'round' : 'manual',
  auto_respond: viewerMember ? viewerMember.auto_respond === 1 : true,
  next_agent_id: viewerMember?.next_agent_id ?? null,
  agents: listActiveAgents(chat.id),
  members: listMembers(chat.id).map(toMemberDto),
});

/** Resolve chat + caller's membership. Owner fallback keeps legacy single-user behavior. */
const resolveRoomAccess = (userId: number, chatId: number): { chat: ChatRoomRow; member: ChatMemberRow } => {
  const chat = getAccessibleChat(userId, chatId);
  if (!chat) throw new Error('chat_not_found');
  let member = getMember(chat.id, userId);
  if (!member) {
    if (chat.user_id !== userId) throw new Error('chat_not_found');
    // Legacy fallback: room predates chat_members — materialize the owner's row.
    db.prepare(`
      INSERT INTO chat_members (chat_id, user_id, role, response_mode, auto_respond, next_agent_id, sort_order)
      VALUES (?, ?, 'admin',
              COALESCE((SELECT room_response_mode FROM user_chats WHERE id = ?), 'manual'),
              COALESCE((SELECT room_auto_respond FROM user_chats WHERE id = ?), 1),
              (SELECT room_next_agent_id FROM user_chats WHERE id = ?),
              0)
    `).run(chat.id, userId, chat.id, chat.id, chat.id);
    member = getMember(chat.id, userId);
    if (!member) throw new Error('chat_not_found');
  }
  return { chat, member };
};

const requireRoom = (userId: number, chatId: number) => {
  const access = resolveRoomAccess(userId, chatId);
  if (access.chat.room_enabled !== 1) throw new Error('room_not_created');
  return access;
};

const requireRoomAdmin = (userId: number, chatId: number) => {
  const access = requireRoom(userId, chatId);
  if (access.member.role !== 'admin') throw new Error('forbidden');
  return access;
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
  const chat = getAccessibleChat(userId, chatId);
  if (!chat) return null;
  return toRoomDto(chat, getMember(chat.id, userId));
};

export const createChatRoom = (userId: number, chatId: number): ChatRoomDto => db.transaction(() => {
  const chat = getOwnedChat(userId, chatId);
  if (!chat) throw new Error('chat_not_found');
  if (chat.room_enabled === 1) return toRoomDto(chat, getMember(chatId, userId));

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
        default_prompt_id = COALESCE(default_prompt_id, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(prompt.id, chatId, userId);
  // Owner becomes room admin. Legacy room_* columns (if any) seed the member row.
  db.prepare(`
    INSERT INTO chat_members (chat_id, user_id, role, response_mode, auto_respond, next_agent_id, sort_order)
    VALUES (?, ?, 'admin',
            COALESCE((SELECT room_response_mode FROM user_chats WHERE id = ?), 'manual'),
            COALESCE((SELECT room_auto_respond FROM user_chats WHERE id = ?), 1),
            ?,
            0)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      next_agent_id = COALESCE(chat_members.next_agent_id, excluded.next_agent_id)
  `).run(chatId, userId, chatId, chatId, agentId);
  return toRoomDto(getOwnedChat(userId, chatId)!, getMember(chatId, userId));
})();

export const deleteChatRoom = (userId: number, chatId: number): ChatRoomDto => db.transaction(() => {
  const { chat } = requireRoomAdmin(userId, chatId);
  const activeCount = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM chat_agents WHERE chat_id = ? AND is_active = 1
  `).get(chatId) as { count: number }).count);
  if (activeCount > 0) throw new Error('room_has_agents');
  db.prepare(`
    UPDATE user_chats
    SET room_enabled = 0, room_next_agent_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(chatId);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chatId);
  return toRoomDto({ ...chat, room_enabled: 0 }, null);
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
  const agentId = Number(inserted.lastInsertRowid);
  db.prepare(`
    UPDATE chat_members
    SET next_agent_id = COALESCE(next_agent_id, ?)
    WHERE chat_id = ? AND user_id = ?
  `).run(agentId, chatId, userId);
  return toRoomDto(requireRoom(userId, chatId).chat, getMember(chatId, userId));
})();

export const updateChatAgent = (
  userId: number,
  chatId: number,
  agentId: number,
  fields: { name?: string; promptContent?: string; sourcePromptId?: number },
): ChatRoomDto => db.transaction(() => {
  const { chat, member } = requireRoom(userId, chatId);
  const agent = db.prepare(`
    SELECT id, name, owner_user_id FROM chat_agents WHERE id = ? AND chat_id = ? AND is_active = 1
  `).get(agentId, chatId) as { id: number; name: string; owner_user_id: number } | undefined;
  if (!agent) throw new Error('agent_not_found');
  // Only the room admin or the agent's owner may edit the agent.
  if (member.role !== 'admin' && agent.owner_user_id !== userId) throw new Error('forbidden');

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
  if (updates.length === 0) return toRoomDto(chat, getMember(chatId, userId));
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(agentId, chatId);
  db.prepare(`UPDATE chat_agents SET ${updates.join(', ')} WHERE id = ? AND chat_id = ?`).run(...params);
  return toRoomDto(chat, getMember(chatId, userId));
})();

export const removeChatAgent = (userId: number, chatId: number, agentId: number): ChatRoomDto => db.transaction(() => {
  const { chat, member } = requireRoom(userId, chatId);
  const agent = db.prepare(`
    SELECT id, owner_user_id FROM chat_agents WHERE id = ? AND chat_id = ? AND is_active = 1
  `).get(agentId, chatId) as { id: number; owner_user_id: number } | undefined;
  if (!agent) throw new Error('agent_not_found');
  if (member.role !== 'admin' && agent.owner_user_id !== userId) throw new Error('forbidden');

  db.prepare(`
    UPDATE chat_agents
    SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND chat_id = ?
  `).run(agentId, chatId);
  compactAgentOrder(chatId);
  const firstAgent = db.prepare(`
    SELECT id FROM chat_agents
    WHERE chat_id = ? AND is_active = 1
    ORDER BY sort_order ASC, id ASC LIMIT 1
  `).get(chatId) as { id: number } | undefined;
  db.prepare(`
    UPDATE chat_members
    SET next_agent_id = CASE WHEN next_agent_id = ? THEN ? ELSE next_agent_id END
    WHERE chat_id = ?
  `).run(agentId, firstAgent?.id ?? null, chatId);
  db.prepare('UPDATE user_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chatId);
  return toRoomDto(chat, getMember(chatId, userId));
})();

export const reorderChatAgents = (userId: number, chatId: number, agentIds: number[]): ChatRoomDto => db.transaction(() => {
  const { chat } = requireRoomAdmin(userId, chatId);
  const activeIds = listActiveAgents(chatId).map(agent => agent.id);
  if (agentIds.length !== activeIds.length || new Set(agentIds).size !== agentIds.length) {
    throw new Error('bad_agent_order');
  }
  const expected = new Set(activeIds);
  if (agentIds.some(id => !expected.has(id))) throw new Error('bad_agent_order');
  const update = db.prepare('UPDATE chat_agents SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND chat_id = ?');
  agentIds.forEach((agentId, index) => update.run(index, agentId, chatId));
  return toRoomDto(chat, getMember(chatId, userId));
})();

export const updateChatRoomSettings = (
  userId: number,
  chatId: number,
  fields: { responseMode?: 'manual' | 'round'; autoRespond?: boolean; nextAgentId?: number | null },
): ChatRoomDto => db.transaction(() => {
  const { chat } = requireRoom(userId, chatId);
  const updates: string[] = [];
  const params: Array<string | number | null> = [];
  if (fields.responseMode !== undefined) {
    updates.push('response_mode = ?');
    params.push(fields.responseMode);
  }
  if (fields.autoRespond !== undefined) {
    updates.push('auto_respond = ?');
    params.push(fields.autoRespond ? 1 : 0);
  }
  if (fields.nextAgentId !== undefined) {
    if (fields.nextAgentId !== null) {
      const exists = db.prepare(`
        SELECT id FROM chat_agents WHERE id = ? AND chat_id = ? AND is_active = 1
      `).get(fields.nextAgentId, chatId);
      if (!exists) throw new Error('agent_not_found');
    }
    updates.push('next_agent_id = ?');
    params.push(fields.nextAgentId);
  }
  if (updates.length > 0) {
    params.push(chatId, userId);
    db.prepare(`UPDATE chat_members SET ${updates.join(', ')} WHERE chat_id = ? AND user_id = ?`).run(...params);
    db.prepare('UPDATE user_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chatId);
  }
  return toRoomDto(chat, getMember(chatId, userId));
})();

// ── Room invites ──────────────────────────────────────────────────────────

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type ChatInviteDto = {
  token: string;
  chat_id: number;
  created_by: number;
  created_at: number;
  expires_at: number | null;
};

const generateInviteToken = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

export const createChatRoomInvite = (userId: number, chatId: number): ChatInviteDto => {
  requireRoomAdmin(userId, chatId);
  const token = generateInviteToken();
  const now = getNowUnix();
  db.prepare(`
    INSERT INTO chat_invites (token, chat_id, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, chatId, userId, now, now + INVITE_TTL_SECONDS);
  return { token, chat_id: chatId, created_by: userId, created_at: now, expires_at: now + INVITE_TTL_SECONDS };
};

export const listChatRoomInvites = (userId: number, chatId: number): ChatInviteDto[] => {
  requireRoomAdmin(userId, chatId);
  return db.prepare(`
    SELECT token, chat_id, created_by, created_at, expires_at
    FROM chat_invites
    WHERE chat_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
  `).all(chatId, getNowUnix()) as ChatInviteDto[];
};

export const revokeChatRoomInvite = (userId: number, chatId: number, token: string): void => {
  requireRoomAdmin(userId, chatId);
  db.prepare('UPDATE chat_invites SET revoked_at = CURRENT_TIMESTAMP WHERE token = ? AND chat_id = ?')
    .run(token, chatId);
};

const getValidInvite = (token: string) => db.prepare(`
  SELECT token, chat_id, created_by, created_at, expires_at
  FROM chat_invites
  WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
`).get(token, getNowUnix()) as ChatInviteDto | undefined;

/** Public invite info (authed): what the joiner will see before joining. */
export const getChatRoomInviteInfo = (token: string): { chat_id: number; title: string; inviter_name: string | null } | null => {
  const invite = getValidInvite(token);
  if (!invite) return null;
  const chat = db.prepare('SELECT id, title FROM user_chats WHERE id = ?')
    .get(invite.chat_id) as { id: number; title: string } | undefined;
  if (!chat) return null;
  const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(invite.created_by) as { name: string | null } | undefined;
  return { chat_id: invite.chat_id, title: chat.title, inviter_name: inviter?.name ?? null };
};

/** Join a room via invite token. Idempotent for existing members. */
export const joinChatRoomByInvite = (userId: number, token: string): { chat_id: number; room: ChatRoomDto } => {
  const invite = getValidInvite(token);
  if (!invite) throw new Error('invite_not_found');
  const chat = db.prepare('SELECT id, user_id, room_enabled FROM user_chats WHERE id = ?')
    .get(invite.chat_id) as { id: number; user_id: number; room_enabled: number } | undefined;
  if (!chat) throw new Error('chat_not_found');
  if (chat.room_enabled !== 1) throw new Error('room_not_created');

  const existing = getMember(chat.id, userId);
  if (!existing && chat.user_id !== userId) {
    const nextOrder = Number((db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM chat_members WHERE chat_id = ?
    `).get(chat.id) as { next_order: number }).next_order);
    db.prepare(`
      INSERT INTO chat_members (chat_id, user_id, role, sort_order)
      VALUES (?, ?, 'member', ?)
    `).run(chat.id, userId, nextOrder);
  }
  return { chat_id: chat.id, room: toRoomDto(chat, getMember(chat.id, userId)) };
};

export const leaveChatRoom = (userId: number, chatId: number): void => {
  const { chat } = requireRoom(userId, chatId);
  if (chat.user_id === userId) throw new Error('owner_cannot_leave');
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
};

/** User ids allowed to read this chat's messages: owner + all members. */
export const listRoomReaderUserIds = (chatId: number): number[] | null => {
  const chat = db.prepare('SELECT id, user_id, room_enabled FROM user_chats WHERE id = ?')
    .get(chatId) as { id: number; user_id: number; room_enabled: number } | undefined;
  if (!chat) return null;
  const memberIds = (db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chat.id) as Array<{ user_id: number }>)
    .map(row => row.user_id);
  return memberIds.includes(chat.user_id) ? memberIds : [chat.user_id, ...memberIds];
};

/** Can this user read messages of this chat (owner or room member)? */
export const canReadChatMessages = (userId: number, chatId: number): boolean => {
  const chat = db.prepare('SELECT id, user_id FROM user_chats WHERE id = ?')
    .get(chatId) as { id: number; user_id: number } | undefined;
  if (!chat) return false;
  if (chat.user_id === userId) return true;
  return Boolean(db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId));
};
