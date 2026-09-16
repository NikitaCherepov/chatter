import { listUserChats } from '../../chats.js';
import type { Tool } from '../types.js';

export const listRecentChatsTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_recent_chats',
      description: 'List the user\'s recently updated visible chats. Returns titles and IDs, not message contents.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum chats (default 20, maximum 40).' },
        },
      },
    },
  },
  handler: async (args, context) => {
    const requested = Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 20;
    const limit = Math.max(1, Math.min(40, requested));
    const chats = listUserChats(context.userId, 100, 0)
      .filter(chat => !chat.bot_hidden)
      .slice(0, limit);
    if (chats.length === 0) return 'No visible chats found.';
    return chats
      .map(chat => `[chat_id: ${chat.id}] ${chat.title} (updated_at: ${chat.updated_at})`)
      .join('\n');
  },
};
