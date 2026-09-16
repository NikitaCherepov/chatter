import { searchChatHistory } from '../../chats.js';
import type { Tool } from '../types.js';

export const searchChatHistoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_chat_history',
      description: 'Search the user\'s visible chat history by keywords and return matching messages with chat and message IDs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords separated by spaces. Partial words are supported.' },
          limit: { type: 'number', description: 'Maximum results (default 20, maximum 50).' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args, context) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'No results: empty search query.';
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20;
    const hits = searchChatHistory(context.userId, query, limit);
    if (hits.length === 0) return `No messages found for "${query}".`;
    const lines = hits.map(hit =>
      `[chat_id: ${hit.chat_id}] [message_id: ${hit.message_id}]\nChat: "${hit.chat_title}" (${hit.role})\n…${hit.snippet}…`,
    );
    return `Found ${hits.length} message(s):\n\n${lines.join('\n\n')}`;
  },
};
