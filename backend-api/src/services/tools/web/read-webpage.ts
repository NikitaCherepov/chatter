import { getUserById } from '../../chats.js';
import { getCleanTextFromUrl } from '../../web-reader.js';
import type { Tool } from '../types.js';
import { checkWebReaderQuota, consumeWebReaderQuota } from './quota.js';

export const readWebpageTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_webpage',
      description: 'Reads the content of a webpage by URL. If a continuation cursor is returned, call the tool again with the same URL and cursor to read the next part.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full page URL (http/https).' },
          cursor: { type: 'string', description: 'Continuation cursor returned by a previous read_webpage call. Keep the URL unchanged.' },
        },
        required: ['url'],
      },
    },
  },
  handler: async (args, context) => {
    const user = context.user;
    if (!user) return 'Tool error: user context is unavailable.';
    const url = `${args.url || ''}`.trim();
    if (!url) return 'Tool error: empty URL.';
    const billingUser = context.billingUser || user;
    try {
      return await getCleanTextFromUrl(url, {
        userId: user.id,
        chatId: context.chatId,
        cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
        signal: context.signal,
        browserlessQuota: {
          check: () => {
            const currentBillingUser = getUserById(billingUser.id) ?? billingUser;
            if (currentBillingUser.is_admin === 1) return null;
            const limit = checkWebReaderQuota(currentBillingUser);
            return limit.allowed ? null : limit.reason;
          },
          consume: () => consumeWebReaderQuota(billingUser.id),
        },
      });
    } catch (error: any) {
      const reason = `${error?.message || String(error)}`;
      if (reason === 'web_reader_disabled') {
        return 'Tool error: web page reading is disabled by the administrator.';
      }
      if (reason === 'web_reader_no_provider_available') {
        return 'Tool error: no web page reader provider is currently enabled or available.';
      }
      if (reason === 'unsafe_url' || reason === 'desktop_web_reader_url_blocked') {
        return 'Tool error: this URL is blocked because it targets a local or private network.';
      }
      if (reason === 'web_reader_cursor_invalid' || reason === 'web_reader_cursor_expired' || reason === 'web_reader_cursor_mismatch') {
        return 'Tool error: the web page cursor is invalid, expired, or belongs to another URL. Read the page again without a cursor.';
      }
      return `Tool error read_webpage: ${reason}`;
    }
  },
};
