import crypto from 'node:crypto';
import { normalizeMcpApproval, emptyMcpApproval } from './approval-policy.js';
import { wsClients, notifyMcpSettingsUpdated, type WsClient } from '../../ws-clients.js';
import { policy, type McpConnection } from './store.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';

const snapshots = new Map<number, { client: WsClient; rows: McpConnection[] }>();
function metadata(input: any) {
  const tools = input.tools || [],
    resources = input.resources || [],
    templates = input.resource_templates || [];
  if (
    !Array.isArray(tools) ||
    tools.length > 200 ||
    !Array.isArray(resources) ||
    resources.length > 500 ||
    !Array.isArray(templates) ||
    templates.length > 200
  )
    throw new Error('mcp_invalid_local_metadata');
  const names = new Set<string>();
  for (const tool of tools) {
    if (
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) ||
      names.has(tool.name) ||
      tool.inputSchema?.type !== 'object'
    )
      throw new Error('mcp_invalid_tool_schema');
    names.add(tool.name);
    const schema = JSON.stringify(tool.inputSchema);
    if (schema.length > 64000 || /"\$ref"\s*:\s*"(?!#)/.test(schema))
      throw new Error('mcp_invalid_tool_schema');
  }
  const resource = (item: any, template: boolean) => {
    const uri = template ? item.uriTemplate : item.uri;
    if (typeof uri !== 'string' || !uri || uri.length > 4096 || /[\u0000-\u001f]/.test(uri))
      throw new Error('mcp_invalid_resource_catalog');
    if (template) new UriTemplate(uri);
    else new URL(uri);
    return {
      ...(template ? { uriTemplate: uri } : { uri }),
      name: String(item.name || uri).slice(0, 160),
      description: String(item.description || '').slice(0, 1500),
      mimeType: String(item.mimeType || '').slice(0, 128),
    };
  };
  return {
    tools_json: JSON.stringify(
      tools.map((t) => ({
        name: t.name,
        description: String(t.description || '').slice(0, 3000),
        inputSchema: t.inputSchema,
      })),
    ),
    resources_json: JSON.stringify(resources.map((r) => resource(r, false))),
    templates_json: JSON.stringify(templates.map((r) => resource(r, true))),
    capabilities_json: input.capabilities
      ? JSON.stringify({
          tools: !!input.capabilities.tools,
          resources: !!input.capabilities.resources,
          prompts: !!input.capabilities.prompts,
        })
      : null,
    server_info_json: JSON.stringify({
      name: String(input.server_info?.name || '').slice(0, 160),
      description: String(input.server_info?.description || '').slice(0, 1500),
      version: String(input.server_info?.version || '').slice(0, 100),
    }),
  };
}
export function getLocalConnections(userId: number): McpConnection[] {
  const state = snapshots.get(userId),
    client = wsClients.get(userId);
  if (!state || client !== state.client || client.ws.readyState !== 1) {
    snapshots.delete(userId);
    return [];
  }
  return state.rows;
}
export function syncLocalConnections(client: WsClient, input: unknown) {
  if (wsClients.get(client.accountId) !== client) throw new Error('mcp_desktop_connection_changed');
  const access = policy(client.accountId);
  if (!Array.isArray(input) || input.length > 20 || JSON.stringify(input).length > 2_000_000)
    throw new Error('mcp_invalid_local_snapshot');
  if (!access.enabled || !access.allow_custom) {
    snapshots.delete(client.accountId);
    notifyMcpSettingsUpdated(client.accountId);
    return 0;
  }
  const ids = new Set<string>();
  const rows = input.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error('mcp_invalid_local_snapshot');
    ids.add(item.id);
    const timeout = Number(item.timeout_seconds ?? 300);
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600)
      throw new Error('mcp_invalid_local_snapshot');
    const hash = crypto
      .createHash('sha256')
      .update(client.accountId + ':' + item.id)
      .digest('hex')
      .slice(0, 12);
    return {
      id: 1_000_000_000_000 + parseInt(hash, 16),
      user_id: client.accountId,
      server_id: null,
      name: String(item.name || item.id).slice(0, 120),
      url: 'stdio:' + item.id,
      transport: 'stdio' as const,
      local_id: item.id,
      installed_version: typeof item.installed_version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+!_~-]{0,99}$/.test(item.installed_version)
        ? item.installed_version : undefined,
      config_revision:
        typeof item.config_revision === 'string' ? item.config_revision.slice(0, 80) : undefined,
      approval_policy_json: JSON.stringify(
        item.approval_policy ? normalizeMcpApproval(item.approval_policy) : emptyMcpApproval(),
      ),
      enabled: item.enabled === true ? 1 : 0,
      mode: item.mode === 'eager' ? ('eager' as const) : ('search' as const),
      timeout_seconds: timeout,
      credentials: null,
      selected_tools: JSON.stringify(
        Array.isArray(item.selected_tools) ? item.selected_tools.slice(0, 200) : null,
      ),
      updated_at: Date.now(),
      ...metadata(item),
    };
  });
  snapshots.set(client.accountId, { client, rows });
  notifyMcpSettingsUpdated(client.accountId);
  return rows.length;
}
export function updateLocalMetadata(userId: number, id: string, input: any) {
  const row = getLocalConnections(userId).find((row) => row.local_id === id);
  if (!row) throw new Error('mcp_desktop_not_connected');
  Object.assign(row, metadata(input), { updated_at: Date.now() });
  notifyMcpSettingsUpdated(userId);
}

export function dropLocalConnections(client: WsClient) {
  if (snapshots.get(client.accountId)?.client === client) snapshots.delete(client.accountId);
}
