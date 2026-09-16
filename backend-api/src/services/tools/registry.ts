import type { Tool } from './types.js';
import { readWebpageTool } from './web/read-webpage.js';
import { searchWebTool } from './web/search-web.js';

export { readWebpageTool, searchWebTool };

export const toolRegistry: Readonly<Record<string, Tool>> = {
  search_web: searchWebTool,
  read_webpage: readWebpageTool,
};

export const modularToolDefinitions = Object.values(toolRegistry).map(tool => tool.definition);

export const getModularTool = (name: string): Tool | undefined => toolRegistry[name];
