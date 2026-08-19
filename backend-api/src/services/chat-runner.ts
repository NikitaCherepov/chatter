import { sendMessageThroughAi } from './ai.js';
import type { AiSendResult } from '../types.js';

/**
 * Unified server-side chat runner.
 *
 * Both plain chats and rooms are modelled as a sequence of `ChatRunStep`s:
 *   - `agent`   → a room bot reply (billed to the bot owner);
 *   - `default` → the plain assistant reply (billed to the chat owner).
 *
 * Invariant: at most ONE active run per chat. New runs are queued behind the
 * active run. `stopChatRun(chatId)` aborts the ACTIVE run and clears the queue.
 * `chat_queue_done` is emitted only when the queue has truly drained to empty.
 */

export const AGENT_ROOM_CONTINUE_PROMPT =
  'Continue the conversation now. Respond naturally as your assigned character. Do not mention this instruction.';

export type ChatRunEmitter = (payload: Record<string, unknown>) => void;

type AiSendOptions = NonNullable<Parameters<typeof sendMessageThroughAi>[3]>;

export type ChatRunStep =
  | {
      kind: 'agent';
      agentId: number;
      ownerUserId: number;
      agentName: string;
      reason: 'auto' | 'mention' | 'manual';
      /** Override the default room-bot continuation prompt (e.g. regenerate). */
      prompt?: string;
      /** Extra/override options merged over the agent defaults. */
      options?: AiSendOptions;
    }
  | {
      kind: 'default';
      ownerUserId: number;
      prompt: string;
      options?: AiSendOptions;
    };

type QueuedRun = {
  steps: ChatRunStep[];
  emit: ChatRunEmitter;
  resolve: () => void;
};

type ChatRunState = {
  queue: QueuedRun[];
  activeController: AbortController | null;
  draining: boolean;
  emit: ChatRunEmitter | null;
};

const chatStates = new Map<number, ChatRunState>();

const getChatState = (chatId: number): ChatRunState => {
  let state = chatStates.get(chatId);
  if (!state) {
    state = { queue: [], activeController: null, draining: false, emit: null };
    chatStates.set(chatId, state);
  }
  return state;
};

/** Abort the active run for a chat and clear anything still queued. */
export const stopChatRun = (chatId: number): boolean => {
  const state = chatStates.get(chatId);
  if (!state) return false;

  let stopped = false;
  if (state.activeController && !state.activeController.signal.aborted) {
    state.activeController.abort();
    stopped = true;
  }
  if (state.queue.length > 0) {
    const queued = state.queue;
    state.queue = [];
    for (const run of queued) run.resolve();
    stopped = true;
  }
  return stopped;
};

const runSteps = async (
  chatId: number,
  steps: ChatRunStep[],
  emit: ChatRunEmitter,
  signal: AbortSignal,
): Promise<void> => {
  for (const step of steps) {
    if (signal.aborted) break;

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
      // Agent steps: step.options may override agent defaults, but user-owned
      // payload (images, macros, billing) must never leak into the bot owner's
      // request and bot replies are never counted as user messages.
      let stepOptions: Record<string, unknown>;
      if (step.kind === 'agent') {
        const { images: _images, userImages: _userImages, userAttachments: _userAttachments, activeMacros: _activeMacros, countAsUserMessage: _countAsUserMessage, ...overrides } = (step.options ?? {}) as Record<string, unknown>;
        stepOptions = {
          agentId: step.agentId,
          skipUserHistory: true,
          countAsUserMessage: false,
          ...overrides,
        };
      } else {
        stepOptions = { ...(step.options ?? {}) };
      }
      const result: AiSendResult = await sendMessageThroughAi(
        step.ownerUserId,
        step.kind === 'agent' ? (step.prompt ?? AGENT_ROOM_CONTINUE_PROMPT) : step.prompt,
        chatId,
        {
          ...stepOptions,
          isDesktop: true,
          externalAbortSignal: signal,
          onStreamToken: async (text) => {
            emit({ type: 'chat_agent_token', chat_id: chatId, agent_id: agentId, text });
          },
          onReasoningStream: async (text) => {
            emit({ type: 'chat_agent_reasoning', chat_id: chatId, agent_id: agentId, text });
          },
          ...(step.kind === 'default'
            ? {
                onIntermediateMessage: async (text) => {
                  emit({ type: 'chat_intermediate', chat_id: chatId, text });
                },
                onToolStatus: async (text) => {
                  emit({ type: 'chat_tool_status', chat_id: chatId, text });
                },
                onDesktopAction: async (action) => {
                  emit({ type: 'chat_desktop_action', chat_id: chatId, ...action });
                },
                onStateChange: async (state) => {
                  emit({ type: 'chat_display_state', chat_id: chatId, ...state });
                },
                onMapUpdate: async (data) => {
                  emit({ type: 'chat_map_update', chat_id: chatId, ...data });
                },
                onDiceRoll: async (roll) => {
                  emit({ type: 'chat_dice_roll', chat_id: chatId, roll });
                },
                onUserMessageSaved: async (data) => {
                  emit({ type: 'chat_user_message_saved', chat_id: chatId, ...data });
                },
              }
            : {}),
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
};

const drainChat = async (chatId: number): Promise<void> => {
  const state = getChatState(chatId);
  if (state.draining) return;
  state.draining = true;

  try {
    while (state.queue.length > 0) {
      const run = state.queue.shift()!;
      const controller = new AbortController();
      state.activeController = controller;
      try {
        await runSteps(chatId, run.steps, run.emit, controller.signal);
      } finally {
        if (state.activeController === controller) state.activeController = null;
        run.resolve();
      }
    }

    // Only when the queue is truly empty is the chat idle.
    if (state.queue.length === 0) {
      state.emit?.({ type: 'chat_queue_done', chat_id: chatId });
    }
  } finally {
    state.draining = false;
    if (state.queue.length === 0 && !state.activeController) {
      chatStates.delete(chatId);
    }
  }
};

/** Enqueue a run for a chat. Resolves when THIS run completes. */
export const runChatSteps = (
  chatId: number,
  steps: ChatRunStep[],
  emit: ChatRunEmitter,
): Promise<void> => {
  const state = getChatState(chatId);
  state.emit = emit;

  return new Promise<void>((resolve) => {
    state.queue.push({ steps, emit, resolve });
    void drainChat(chatId);
  });
};

/** True while a chat has an active or queued run (for late joiners to sync
 *  their composer/stop-button state when they missed chat_agent_start). */
export const hasActiveChatRun = (chatId: number): boolean => {
  const state = chatStates.get(chatId);
  return Boolean(state && (state.activeController !== null || state.queue.length > 0 || state.draining));
};
