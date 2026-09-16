import { getUserById } from '../../chats.js';
import { runWebSearch } from '../../web-search.js';
import type { Tool } from '../types.js';
import { checkWebSearchQuota, consumeWebSearchQuota } from './quota.js';

export const searchWebTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search for current/verifiable information on the internet. Use when fresh data or facts from the web are needed. After calling, rely on search results in your response.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          cursor: { type: 'string', description: 'Pagination cursor returned by the previous search. Omit for the first search.' },
          wikipedia: { type: 'boolean', description: 'When true, search only Wikipedia. Cannot be combined with news, date sorting, or freshness filters. Defaults to false.', default: false },
          search_type: { type: 'string', enum: ['web', 'news'], description: 'Search regular web pages or news. Defaults to web.', default: 'web' },
          sort: { type: 'string', enum: ['relevance', 'date'], description: 'Sort results by relevance or newest first. Defaults to relevance.', default: 'relevance' },
          freshness: { type: 'string', enum: ['any', 'day', 'week', 'month', 'year'], description: 'Limit results to a recent time period. Defaults to any.', default: 'any' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args, context) => {
    const user = context.user;
    if (!user) return 'Tool error: user context is unavailable.';
    const query = `${args.query || ''}`.trim();
    if (!query) return 'Tool error: empty search query.';
    const billingUser = context.billingUser || user;
    return runWebSearch(query, {
      userId: user.id,
      chatId: context.chatId,
      cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
      wikipedia: args.wikipedia === true,
      searchType: args.search_type === 'news' ? 'news' : 'web',
      sort: args.sort === 'date' ? 'date' : 'relevance',
      freshness: ['day', 'week', 'month', 'year'].includes(`${args.freshness || ''}`) ? args.freshness : 'any',
      language: user.language,
      tavilyQuota: {
        check: () => {
          const currentBillingUser = getUserById(billingUser.id) ?? billingUser;
          if (currentBillingUser.is_admin === 1) return null;
          const limit = checkWebSearchQuota(currentBillingUser);
          return limit.allowed ? null : limit.reason;
        },
        consume: () => consumeWebSearchQuota(billingUser.id),
      },
    }, context.signal);
  },
};
