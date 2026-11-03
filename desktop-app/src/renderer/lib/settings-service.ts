import * as api from './api';

export const settingsReads = {
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
