import { db } from '../db.js';
import { sendMessageThroughAi } from './ai.js';
import type { AiSendResult } from '../types.js';

/**
 * Server-side room response orchestration.
 *
 * Replaces the desktop-driven runRoomAgentSequence: after a human message
 * lands in a room, the SERVER walks participants and generates agent replies
 * sequentially, billing each reply to the agent's owner.
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

export const ROOM_RUNNER_PROMPT =
  'Continue the conversation now. Respond naturally as your assigned character. Do not mention this instruction.';

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

export type RoomRunEmitter = (payload: Record<string, unknown>) => void;

const roomRunChains = new Map<number, Promise<void>>();

/** Sequentially run the given steps, serialized per chat. */
const runStepsSerialized = async (
  chatId: number,
  steps: RoomResponseStep[],
  emit: RoomRunEmitter,
): Promise<void> => {
  const previous = roomRunChains.get(chatId) ?? Promise.resolve();
  const chained = previous.then(async () => {
    for (const { agent, reason } of steps) {
      emit({ type: 'room_agent_start', chat_id: chatId, agent_id: agent.id, agent_name: agent.name, owner_user_id: agent.owner_user_id, reason });
      try {
        const result: AiSendResult = await sendMessageThroughAi(agent.owner_user_id, ROOM_RUNNER_PROMPT, chatId, {
          agentId: agent.id,
          skipUserHistory: true,
          countAsUserMessage: false,
          isDesktop: true,
          onStreamToken: async (text) => {
            emit({ type: 'room_agent_token', chat_id: chatId, agent_id: agent.id, text });
          },
          onReasoningStream: async (text) => {
            emit({ type: 'room_agent_reasoning', chat_id: chatId, agent_id: agent.id, text });
          },
        });
        emit({ type: 'room_agent_done', chat_id: chatId, agent_id: agent.id, result });
        if (result.aborted) break;
      } catch (err: any) {
        console.error('[room-runner] agent generation failed', { chatId, agentId: agent.id, error: err?.message });
        emit({ type: 'room_agent_error', chat_id: chatId, agent_id: agent.id, error: err?.message || 'generation_failed' });
        // Quota / provider errors of one member's bot must not block the rest.
      }
    }
  }).catch(() => {});
  roomRunChains.set(chatId, chained);
  try {
    await chained;
  } finally {
    if (roomRunChains.get(chatId) === chained) roomRunChains.delete(chatId);
  }
};

/**
 * Run the room response queue sequentially. Serialized per chat so two senders
 * cannot interleave generations. Events are emitted to every room reader
 * (the caller broadcasts them over WS).
 */
export const runRoomResponseQueue = async (
  chatId: number,
  senderId: number,
  userText: string,
  emit: RoomRunEmitter,
): Promise<void> => {
  const steps = computeRoomResponseQueue(senderId, chatId, userText);
  await runStepsSerialized(chatId, steps, emit);
};

/**
 * Manual trigger (the "Reply" / "Reply in order" buttons): run exactly the
 * requested agents in the given order. Only agents the initiator owns or that
 * are shared are allowed. Everyone (including the initiator) watches via
 * room_agent_* WS events.
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
  await runStepsSerialized(chatId, steps, emit);
};
