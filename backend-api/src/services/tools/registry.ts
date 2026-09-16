import type { Tool } from './types.js';
import { readChatContextTool } from './chats/read-chat-context.js';
import { searchChatHistoryTool } from './chats/search-chat-history.js';
import { searchColdMemoryTool } from './memory/search-cold-memory.js';
import { readWebpageTool } from './web/read-webpage.js';
import { searchWebTool } from './web/search-web.js';

export {
  readChatContextTool,
  searchChatHistoryTool,
  searchColdMemoryTool,
  readWebpageTool,
  searchWebTool,
};

export const toolRegistry: Readonly<Record<string, Tool>> = {
  search_web: searchWebTool,
  read_webpage: readWebpageTool,
  search_cold_memory: searchColdMemoryTool,
  search_chat_history: searchChatHistoryTool,
  read_chat_context: readChatContextTool,
};

export const modularToolDefinitions = Object.values(toolRegistry).map(tool => tool.definition);

export const getModularTool = (name: string): Tool | undefined => toolRegistry[name];
