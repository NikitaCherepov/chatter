import { getChatMessagesAround } from '../../chats.js';
import type { Tool } from '../types.js';

export const readChatContextTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_chat_context',
      description: 'Read messages around a position in one of the user\'s visible chats. Use after listing or searching chats.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'number', description: 'Chat ID returned by another chat tool.' },
          from_message_id: { type: 'number', description: 'Optional message ID to center the window on.' },
          before: { type: 'number', description: 'Messages before the anchor (default 5, maximum 50).' },
          after: { type: 'number', description: 'Messages after the anchor (default 5, maximum 50).' },
        },
        required: ['chat_id'],
      },
    },
  },
  handler: async (args, context) => {
    const chatId = Number(args.chat_id);
    if (!Number.isFinite(chatId)) return 'Error: chat_id must be a number.';
    const fromMessageId = Number.isFinite(Number(args.from_message_id)) ? Number(args.from_message_id) : null;
    const before = Number.isFinite(Number(args.before)) ? Number(args.before) : 5;
    const after = Number.isFinite(Number(args.after)) ? Number(args.after) : 5;
    const result = getChatMessagesAround(context.userId, chatId, fromMessageId, before, after);
    if (!result) return 'Chat not found or access denied.';
    if (result.messages.length === 0) return `Chat "${result.chat_title}" has no messages.`;
    const lines = result.messages.map(message => `[${message.id}] ${message.role}: ${message.content}`);
    const header = `Chat: "${result.chat_title}" (chat_id: ${chatId}, anchor: ${result.anchor_message_id})${result.has_more_before ? ' ← more before' : ''}${result.has_more_after ? ' more after →' : ''}`;
    return `${header}\n${lines.join('\n')}`;
  },
};
