import type { McpApprovalPolicy } from '../../main/local-mcp-spec';
import { apiFetch, localMcpScope, syncLocalMcp } from './api';
import type { LocalMcpInput, NpmMcpPackage } from '../../main/local-mcp-spec';
export type McpTool = { name: string; description?: string };
export type McpServer = {
  id: number;
  name: string;
  url: string;
  description: string;
  recommended?: number;
  transport?: string;
  source?: string;
};
export type McpResource = {
  name: string;
  title?: string;
  description?: string;
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
};
export type McpConnection = {
  approval_policy?: McpApprovalPolicy;
  transport?: 'stdio';
  local_id?: string;
  id: number;
  name: string;
  url: string;
  enabled: number;
  mode: 'eager' | 'search';
  timeout_seconds: number;
  has_credentials: boolean;
  blocked: boolean;
  tools: McpTool[];
  selected_tools: string[] | null;
  resources?: McpResource[];
  resource_templates?: McpResource[];
  capabilities?: { tools: boolean; resources: boolean; prompts: boolean } | null;
  server_info?: { name: string; title?: string; version?: string; description?: string } | null;
};
export type McpState = {
  policy: { enabled: boolean; allow_custom: boolean; show_catalog: boolean };
  servers: McpServer[];
  connections: McpConnection[];
};
const base = '/api/v1/mcp';
export const getMcpState = () => apiFetch<McpState>(base);
export const saveMcpConnection = (body: Record<string, unknown>, id?: number) =>
  apiFetch(base + '/connections' + (id ? '/' + id : ''), {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  });
export const deleteMcpConnection = (id: number) =>
  apiFetch(base + '/connections/' + id, { method: 'DELETE' });
export const refreshMcpTools = (id: number) =>
  apiFetch(base + '/connections/' + id + '/refresh', { method: 'POST' });
export const authorizeMcp = (id: number) =>
  apiFetch<{ authorization_url: string }>(base + '/connections/' + id + '/oauth', {
    method: 'POST',
  });
export const cancelMcp = (id: number) =>
  apiFetch(base + '/connections/' + id + '/cancel', { method: 'POST' });

export type CatalogItem = {
  recommended?: number;
  source?: string;
  transport?: string;
  package?: NpmMcpPackage;
  id?: number;
  name: string;
  title?: string;
  description: string;
  url: string;
  version?: string;
  publisher?: string;
  repository_url?: string;
  website_url?: string;
  registry_url?: string;
};
export const getMcpCatalog = (search: string, cursor = '', signal?: AbortSignal) =>
  apiFetch<{ items: CatalogItem[]; next_cursor: string | null }>(
    base + '/catalog?' + new URLSearchParams({ search, cursor }),
    { signal },
  );

export type LocalMcpSummary = {
  approval_policy?: McpApprovalPolicy;
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  mode: 'search' | 'eager';
  timeout_seconds: number;
  tools: McpTool[];
  resources: McpResource[];
  selected_tools: string[] | null;
  error?: string;
};
export const getLocalMcp = (): Promise<LocalMcpSummary[]> =>
  window.electronAPI.localMcpManage({ action: 'list', scope: localMcpScope() });
async function localManage(action: string, body: any) {
  const result = await window.electronAPI.localMcpManage({
    action,
    scope: localMcpScope(),
    ...body,
  });
  await syncLocalMcp();
  return result;
}
export const installLocalMcp = (input: LocalMcpInput) => localManage('install', { input });
export const configureLocalMcp = (id: string, patch: any) =>
  localManage('configure', { id, patch });
export const removeLocalMcp = (id: string) => localManage('remove', { id });
export const refreshLocalMcp = async (id: string) => {
  const result = await window.electronAPI.localMcpControl({
    action: 'discover',
    scope: localMcpScope(),
    local_id: id,
  });
  await syncLocalMcp();
  return result;
};
