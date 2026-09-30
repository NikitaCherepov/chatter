import { VectorMemoryService } from '../../vector-memory.js';
import type { Tool } from '../types.js';

export const searchColdMemoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_cold_memory',
      description: 'Search the user\'s long-term vector memory. Returns distinct memories with up to two relevant fragments each. Use read_memory with memory_id only when the fragments are insufficient.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search query.' },
          top_k: { type: 'number', description: 'Number of distinct memories to return (1-8, typically 5).' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args, context) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'No results: empty memory query.';
    const topK = Number.isFinite(Number(args.top_k))
      ? Math.max(1, Math.min(8, Math.floor(Number(args.top_k))))
      : 5;
    try {
      const result = await VectorMemoryService.search(context.userId, query, topK, context.chatId);
      if (!result.matches.length) return `No results found in memory for query "${query}".`;
      const matches = result.groups
        .map(group => {
          const fragments = group.fragments
            .map((fragment, index) => [
              `[Fragment ${index + 1}/${group.fragments.length}; chunk_id: ${fragment.chunk_id}; part: ${fragment.chunk_index + 1}/${fragment.total_chunks}]`,
              fragment.text,
            ].join('\n'))
            .join('\n\n');
          return `[memory_id: ${group.record_id}]\n[Source: ${group.fragments[0]?.source || 'unknown'}]\n${fragments}`;
        })
        .join('\n\n---\n\n');
      return `Found in archive. Use read_memory only if a complete record is needed:\n${matches}`;
    } catch (error: any) {
      return `Tool error search_cold_memory: ${error?.message || String(error)}`;
    }
  },
};
