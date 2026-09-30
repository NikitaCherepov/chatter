import { VectorMemoryService } from '../../vector-memory.js';
import type { Tool } from '../types.js';

export const readMemoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read one complete long-term memory by the exact memory_id returned by search_cold_memory. Use only when the search fragments are not enough.',
      parameters: {
        type: 'object',
        properties: {
          memory_id: { type: 'string', description: 'Exact memory_id returned by search_cold_memory.' },
        },
        required: ['memory_id'],
      },
    },
  },
  handler: async (args, context) => {
    const memoryId = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
    if (!memoryId) return 'Tool error read_memory: memory_id is required.';
    try {
      const record = VectorMemoryService.readRecord(context.userId, memoryId, context.chatId);
      const savedAt = record.created_at > 0 ? new Date(record.created_at * 1000).toISOString() : 'unknown';
      return [
        `[memory_id: ${record.memory_id}]`,
        `[Source: ${record.source || 'unknown'}]`,
        `[Saved at: ${savedAt}]`,
        record.text,
      ].join('\n');
    } catch (error: any) {
      return `Tool error read_memory: ${error?.message || String(error)}`;
    }
  },
};
