import { db } from '../db.js';
import { hasActiveChatRun, runChatSteps, stopChatRun, type ChatRunEmitter, type ChatRunStep } from './chat-runner.js';

/**
 * Room response orchestration — now a thin layer over the unified chat-runner.
 *
 * It computes WHO should respond (queue) and delegates the actual sequential
 * execution + streaming (`chat_agent_*` events) to chat-runner.
 *
 * Rules (agreed spec):
 *  - @mentions in the user text trigger exactly the mentioned bots (shared or
 *    owned by the sender), in mention order — overrides auto responses.
 *  - Otherwise walk members by sort_order:
 *      · sender's own bots are always available, other members' bots only
 *        if access = 'shared';
 *      · member's auto_respond off → skip;
 *      · manual → only the member's selected bot (next_agent_id);
 *      · round → all of the member's available bots.
 *  - Every generation runs under the agent OWNER's account (quotas, model).
 */

type RoomAgentRow = {
  id: number;
  owner_user_id: number;
  name: string;
  access: string;
  sort_order: number;
};

type RoomMemberRow = {
  user_id: number;
  role: string;
  response_mode: string;
  auto_respond: number;
  next_agent_id: number | null;
  sort_order: number;
};

export type RoomResponseStep = {
  agent: RoomAgentRow;
  reason: 'mention' | 'auto';
};

export const isRoomChat = (chatId: number): boolean => {
  const chat = db.prepare('SELECT room_enabled FROM user_chats WHERE id = ?')
    .get(chatId) as { room_enabled: number } | undefined;
  return Boolean(chat && chat.room_enabled === 1);
};

/** All member rows of the chat (owner synthesized with defaults if missing). */
const listRoomMemberRows = (chatId: number): RoomMemberRow[] => {
  const chat = db.prepare('SELECT id, user_id FROM user_chats WHERE id = ?')
    .get(chatId) as { id: number; user_id: number } | undefined;
  if (!chat) return [];
  const members = db.prepare(`
    SELECT user_id, role, response_mode, auto_respond, next_agent_id, sort_order
    FROM chat_members
    WHERE chat_id = ?
    ORDER BY sort_order ASC, user_id ASC
  `).all(chatId) as RoomMemberRow[];
  if (!members.some(m => m.user_id === chat.user_id)) {
    members.unshift({
      user_id: chat.user_id,
      role: 'admin',
      response_mode: 'manual',
      auto_respond: 1,
      next_agent_id: null,
      sort_order: -1,
    });
  }
  return members;
};

const listRoomAgents = (chatId: number): RoomAgentRow[] => db.prepare(`
  SELECT id, owner_user_id, name, access, sort_order
  FROM chat_agents
  WHERE chat_id = ? AND is_active = 1
  ORDER BY sort_order ASC, id ASC
`).all(chatId) as RoomAgentRow[];

const parseMentions = (text: string): string[] => {
  const found: string[] = [];
  const re = /@([\p{L}\p{N}_-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) found.push(match[1].toLowerCase());
  return found;
};

/** Compute which agents should respond to a human message, in order. */
export const computeRoomResponseQueue = (
  senderId: number,
  chatId: number,
  userText: string,
): RoomResponseStep[] => {
  const agents = listRoomAgents(chatId);
  if (agents.length === 0) return [];

  // 1. @mentions: exact trigger, mention order, dedup.
  const mentionTokens = parseMentions(userText || '');
  if (mentionTokens.length > 0) {
    const queue: RoomResponseStep[] = [];
    const taken = new Set<number>();
    for (const token of mentionTokens) {
      const agent = agents.find(a =>
        !taken.has(a.id)
        && (a.owner_user_id === senderId || a.access === 'shared')
        && (a.name.toLowerCase() === token || a.name.toLowerCase().startsWith(token)),
      );
      if (agent) {
        taken.add(agent.id);
        queue.push({ agent, reason: 'mention' });
      }
    }
    if (queue.length > 0) return queue;
  }

  // 2. Auto responses per member spec.
  const members = listRoomMemberRows(chatId);
  const queue: RoomResponseStep[] = [];
  for (const member of members) {
    const available = agents.filter(a =>
      a.owner_user_id === member.user_id
      && (member.user_id === senderId || a.access === 'shared'),
    );
    if (available.length === 0) continue;
    if (member.auto_respond !== 1) continue;
    if (member.response_mode === 'manual') {
      const chosen = member.next_agent_id !== null
        ? available.find(a => a.id === member.next_agent_id)
        : undefined;
      if (chosen) queue.push({ agent: chosen, reason: 'auto' });
    } else {
      for (const agent of available) queue.push({ agent, reason: 'auto' });
    }
  }
  return queue;
};

export type RoomRunEmitter = ChatRunEmitter;

/** Abort the currently running room queue for a chat (if any). */
export const stopRoomQueue = stopChatRun;

/** True while the chat has an active or queued run (late-joiner sync). */
export const hasActiveRoomRun = hasActiveChatRun;

const toChatSteps = (steps: RoomResponseStep[], initiatorId: number): ChatRunStep[] =>
  steps.map(({ agent, reason }) => ({
    kind: 'agent',
    agentId: agent.id,
    ownerUserId: agent.owner_user_id,
    initiatorUserId: initiatorId,
    agentName: agent.name,
    reason: reason === 'mention' ? 'mention' : 'auto',
  }));

/** Run the room response queue through the unified chat-runner. */
export const runRoomResponseQueue = async (
  chatId: number,
  senderId: number,
  userText: string,
  emit: RoomRunEmitter,
): Promise<void> => {
  const steps = computeRoomResponseQueue(senderId, chatId, userText);
  await runChatSteps(chatId, toChatSteps(steps, senderId), emit);
};

/**
 * Manual trigger (the "Reply" / "Reply in order" buttons): run exactly the
 * requested agents in the given order. Only agents the initiator owns or that
 * are shared are allowed.
 */
export const runRoomAgents = async (
  chatId: number,
  initiatorId: number,
  agentIds: number[],
  emit: RoomRunEmitter,
): Promise<void> => {
  const agents = listRoomAgents(chatId).filter(a =>
    agentIds.includes(a.id) && (a.owner_user_id === initiatorId || a.access === 'shared'),
  );
  const steps: RoomResponseStep[] = [];
  for (const id of agentIds) {
    const agent = agents.find(a => a.id === id);
    if (agent) steps.push({ agent, reason: 'auto' });
  }
  await runChatSteps(chatId, toChatSteps(steps, initiatorId), emit);
};
