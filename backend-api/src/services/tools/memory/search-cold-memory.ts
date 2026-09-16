import { VectorMemoryService } from '../../vector-memory.js';
import type { Tool } from '../types.js';

export const searchColdMemoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_cold_memory',
      description: 'Search the user\'s long-term vector memory for relevant personal facts and past preferences.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search query.' },
          top_k: { type: 'number', description: 'Number of fragments to return (1-8, typically 5).' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args, context) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'No results: empty memory query.';
    const topK = Number.isFinite(Number(args.top_k)) ? Number(args.top_k) : 5;
    try {
      const result = await VectorMemoryService.search(context.userId, query, topK);
      if (!result.matches.length) return `No results found in memory for query "${query}".`;
      const matches = result.matches
        .map(match => `[chunk_id: ${match.chunk_id}]\n[Source: ${match.source || 'unknown'}]\n${match.text}`)
        .join('\n\n---\n\n');
      return `Found in archive:\n${matches}`;
    } catch (error: any) {
      return `Tool error search_cold_memory: ${error?.message || String(error)}`;
    }
  },
};
