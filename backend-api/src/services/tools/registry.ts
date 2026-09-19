import type { Tool } from './types.js';
import { readChatContextTool } from './chats/read-chat-context.js';
import { searchChatHistoryTool } from './chats/search-chat-history.js';
import { generateImageTool } from './images/generate-image.js';
import { searchColdMemoryTool } from './memory/search-cold-memory.js';
import { readWebpageTool } from './web/read-webpage.js';
import { searchWebTool } from './web/search-web.js';
import { newspaperIssueContentsTool, newspapersListTool, readNewspaperItemTool } from './newspapers.js';

export {
  readChatContextTool,
  searchChatHistoryTool,
  generateImageTool,
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
  generate_image: generateImageTool,
  newspapers_list: newspapersListTool,
  newspaper_issue_contents: newspaperIssueContentsTool,
  read_newspaper_item: readNewspaperItemTool,
};

export const modularToolDefinitions = Object.values(toolRegistry).map(tool => tool.definition);

export const getModularTool = (name: string): Tool | undefined => toolRegistry[name];
