import { sendMessageThroughAi } from './ai.js';
import type { AiSendResult } from '../types.js';

/**
 * Unified server-side chat runner.
 *
 * Both plain chats and rooms are modelled as a sequence of `ChatRunStep`s:
 *   - `agent`   → a room bot reply (billed to the bot owner);
 *   - `default` → the plain assistant reply (billed to the chat owner).
 *
 * Steps run sequentially per chat (a promise chain), are abortable by chat id,
 * and stream unified `chat_agent_*` events to every chat reader. The caller
 * broadcasts those events over WS/SSE.
 */

export const AGENT_ROOM_CONTINUE_PROMPT =
  'Continue the conversation now. Respond naturally as your assigned character. Do not mention this instruction.';

export type ChatRunEmitter = (payload: Record<string, unknown>) => void;

export type ChatRunStep =
  | {
      kind: 'agent';
      agentId: number;
      ownerUserId: number;
      agentName: string;
      reason: 'auto' | 'mention' | 'manual';
    }
  | {
      kind: 'default';
      ownerUserId: number;
      prompt: string;
    };

const chatRunChains = new Map<number, Promise<void>>();
const chatAbortControllers = new Map<number, AbortController>();

/** Abort the currently running chat run for a chat (if any). */
export const stopChatRun = (chatId: number): boolean => {
  const controller = chatAbortControllers.get(chatId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    return true;
  }
  return false;
};

const runStepsSerialized = async (
  chatId: number,
  steps: ChatRunStep[],
  emit: ChatRunEmitter,
): Promise<void> => {
  const previous = chatRunChains.get(chatId) ?? Promise.resolve();
  const controller = new AbortController();
  chatAbortControllers.set(chatId, controller);

  const chained = previous.then(async () => {
    for (const step of steps) {
      if (controller.signal.aborted) break;

      const agentId = step.kind === 'agent' ? step.agentId : null;
      const agentName = step.kind === 'agent' ? step.agentName : 'Chatter';
      const reason = step.kind === 'agent' ? step.reason : 'auto';

      emit({
        type: 'chat_agent_start',
        chat_id: chatId,
        agent_id: agentId,
        agent_name: agentName,
        owner_user_id: step.ownerUserId,
        reason,
      });

      try {
        const result: AiSendResult = await sendMessageThroughAi(
          step.ownerUserId,
          step.kind === 'agent' ? AGENT_ROOM_CONTINUE_PROMPT : step.prompt,
          chatId,
          {
            ...(step.kind === 'agent'
              ? { agentId: step.agentId, skipUserHistory: true, countAsUserMessage: false }
              : {}),
            isDesktop: true,
            externalAbortSignal: controller.signal,
            onStreamToken: async (text) => {
              emit({ type: 'chat_agent_token', chat_id: chatId, agent_id: agentId, text });
            },
            onReasoningStream: async (text) => {
              emit({ type: 'chat_agent_reasoning', chat_id: chatId, agent_id: agentId, text });
            },
          },
        );
        emit({
          type: 'chat_agent_done',
          chat_id: chatId,
          agent_id: agentId,
          owner_user_id: step.ownerUserId,
          result,
        });
        if (result.aborted) break;
      } catch (err: any) {
        console.error('[chat-runner] generation failed', {
          chatId,
          agentId,
          error: err?.message,
        });
        emit({
          type: 'chat_agent_error',
          chat_id: chatId,
          agent_id: agentId,
          error: err?.message || 'generation_failed',
        });
      }
    }
  }).catch(() => {});

  chatRunChains.set(chatId, chained);
  try {
    await chained;
  } finally {
    if (chatAbortControllers.get(chatId) === controller) chatAbortControllers.delete(chatId);
    if (chatRunChains.get(chatId) === chained) chatRunChains.delete(chatId);
  }
};

/** Run a list of steps for a chat, then emit the terminal `chat_queue_done`. */
export const runChatSteps = async (
  chatId: number,
  steps: ChatRunStep[],
  emit: ChatRunEmitter,
): Promise<void> => {
  await runStepsSerialized(chatId, steps, emit);
  emit({ type: 'chat_queue_done', chat_id: chatId });
};
