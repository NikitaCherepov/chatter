import * as api from './api';
import { getMcpState } from './mcp-service';

export const settingsReads = {
  mcp: getMcpState,
  models: api.getModels,
  modelSettings: api.getModelSettings,
  agentModel: api.getSubagentModel,
  agentReasoning: api.getSubagentReasoningLevel,
  ui: api.getUiSettings,
  link: api.getLinkStatus,
  context: api.getContextTokenLimit,
  attachment: api.getAttachmentTokenLimit,
  prompts: api.getPrompts,
  desktopBrowser: () => window.electronAPI.getDesktopBrowserSettings(),
};
