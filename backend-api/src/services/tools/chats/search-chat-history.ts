import { searchChatHistory } from '../../chats.js';
import { getChatMemorySettings } from '../../memory-foundation.js';
import type { Tool } from '../types.js';

export const searchChatHistoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_chat_history',
      description: 'Search visible chat messages by keywords. Can search all accessible chats or only the current chat. Returns message IDs for read_chat_context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords separated by spaces. Partial words are supported.' },
          limit: { type: 'number', description: 'Maximum results (default 20, maximum 50).' },
          current_chat_only: { type: 'boolean', description: 'Set true to search only the current chat instead of all accessible chats.' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args, context) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'No results: empty search query.';
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20;
    const userScope = context.chatId
      ? getChatMemorySettings(context.userId, context.chatId).message_search_scope
      : 'all';
    const currentChatOnly = userScope === 'current' || args.current_chat_only === true;
    if (currentChatOnly && !context.chatId) return 'No results: there is no current chat to search.';
    const hits = searchChatHistory(context.userId, query, limit, currentChatOnly ? context.chatId : null);
    if (hits.length === 0) return `No messages found for "${query}".`;
    const lines = hits.map(hit =>
      `[chat_id: ${hit.chat_id}] [message_id: ${hit.message_id}] [date: ${new Date(hit.created_at * 1000).toISOString()}]\nChat: "${hit.chat_title}" (${hit.role})\n…${hit.snippet}…`,
    );
    return `Found ${hits.length} message(s):\n\n${lines.join('\n\n')}`;
  },
};
