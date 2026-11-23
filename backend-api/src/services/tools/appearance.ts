import { sendIpcToDesktop } from '../../ws-clients.js';
import type { Tool, ToolContext } from './types.js';

async function runAppearanceTool(toolName: string, parsed: Record<string, any>, context: ToolContext) {
  if (parsed.profile !== undefined || parsed.files !== undefined)
    return JSON.stringify({ error: 'appearance_use_local_files', message: 'Read the local THEMES.md and edit a draft with the existing file tools. Submit only its folder id.' });
  const docs = toolName === 'get_theme_docs';
  if (!docs && (typeof parsed.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(parsed.id)))
    return JSON.stringify({ error: 'appearance_invalid' });
  try {
    const result = await sendIpcToDesktop(context.userId, 'appearance_workspace', docs
      ? { action: 'docs' } : { action: 'preview', id: parsed.id, checkOnly: parsed.checkOnly === true }, 30000, context.signal);
    return JSON.stringify(result);
  } catch (error: any) {
    const code = error?.message || 'desktop_offline';
    const message = code === 'appearance_desktop_upgrade_required' ? 'Update Chatter Desktop to use local themes.'
      : ['desktop_not_connected', 'desktop_offline', 'desktop_connection_stale', 'ws_disconnected'].includes(code) ? 'Connect Chatter Desktop and retry the request.'
      : code === 'ipc_timeout' ? 'The desktop did not respond in time. Check its connection and retry.'
      : error?.name === 'AbortError' ? 'The theme request was cancelled.'
      : code.startsWith('appearance_') ? 'The desktop rejected the theme draft. Check its diagnostics and the current project limits in get_theme_docs; restarting the app does not repair an invalid draft.'
      : 'The desktop theme request failed. Check the returned error.';
    return JSON.stringify({ error: code, message, ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}) });
  }
}

export const getThemeDocsTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_theme_docs',
      description: 'Get documentation for creating and editing desktop themes, plus current state: theme directory, active theme, saved themes and drafts. Call before working on themes. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
    },
  },
  handler: (args, context) => runAppearanceTool('get_theme_docs', args, context),
};

export const suggestAppearanceTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'suggest_appearance',
      description: 'Validate or preview a desktop theme draft by its folder ID. Use checkOnly:true for diagnostics without a preview. get_theme_docs provides documentation and current state. Applying a theme requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Folder name under the local .drafts directory.' },
          checkOnly: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
  },
  handler: (args, context) => runAppearanceTool('suggest_appearance', args, context),
};
