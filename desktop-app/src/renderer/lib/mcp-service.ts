import {
  githubMcpRepository,
  type LocalMcpManifest,
  type McpApprovalPolicy,
} from '../../main/local-mcp-spec';
import { API_BASE, apiFetch, localMcpScope, syncLocalMcp } from './api';
import type { LocalMcpInput, LocalMcpInstallPhase, NpmMcpPackage } from '../../main/local-mcp-spec';
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
  server_id?: number | null;
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
  apiFetch<{ connection: McpConnection }>(base + '/connections' + (id ? '/' + id : ''), {
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
    body: JSON.stringify({ callback_url: API_BASE.replace(/\/+$/, '') + '/mcp/oauth/callback' }),
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
  setup_url?: string;
  readme_examples?: string[];
  website_url?: string;
  registry_url?: string;
};
export const getMcpCatalog = (search: string, cursor = '', signal?: AbortSignal) =>
  apiFetch<{ items: CatalogItem[]; next_cursor: string | null }>(
    base + '/catalog?' + new URLSearchParams({ search, cursor }),
    { signal },
  );

export async function importGithubMcp(
  url: string,
  allowRegistry: boolean,
  signal?: AbortSignal,
): Promise<{ items: CatalogItem[] }> {
  const repository = githubMcpRepository(url);
  if (!repository) throw new Error('mcp_invalid_github_url');
  signal?.throwIfAborted();
  let manifestError: unknown;
  try {
    const result: { items: CatalogItem[] } = await window.electronAPI.localMcpManage({
      action: 'import-github',
      url: repository.url,
    });
    signal?.throwIfAborted();
    if (result.items.length) return result;
  } catch (error) {
    signal?.throwIfAborted();
    manifestError = error;
  }

  if (allowRegistry && repository.repo.length >= 3) {
    const result = await getMcpCatalog(repository.repo, '', signal);
    const items = result.items.filter(
      (item) =>
        githubMcpRepository(item.repository_url)?.url.toLowerCase() ===
        repository.url.toLowerCase(),
    );
    if (items.length)
      return { items: items.map((item) => ({ ...item, setup_url: repository.url + '#readme' })) };
  }
  if (manifestError) throw manifestError;
  return { items: [] };
}

export type LocalMcpSummary = {
  approval_policy?: McpApprovalPolicy;
  id: string;
  name: string;
  source: string;
  source_key?: string;
  catalog_id?: number;
  installed_version?: string;
  enabled: boolean;
  mode: 'search' | 'eager';
  timeout_seconds: number;
  tools: McpTool[];
  resources: McpResource[];
  selected_tools: string[] | null;
  error?: string;
  git_commit?: string;
  updatable?: boolean;
};
export const getLocalMcp = (): Promise<LocalMcpSummary[]> =>
  window.electronAPI.localMcpManage({ action: 'list', scope: localMcpScope() });
export type LocalMcpSettings = {
  args?: string[];
  manifest?: LocalMcpManifest;
  env: Record<string, string>;
  config_revision?: string;
  mode: 'search' | 'eager';
  timeout_seconds: number;
};
export const getLocalMcpSettings = (id: string): Promise<LocalMcpSettings> =>
  window.electronAPI.localMcpManage({ action: 'settings', scope: localMcpScope(), id });
async function localManage(
  action: string,
  body: any,
  onProgress?: (phase: LocalMcpInstallPhase) => void,
) {
  const requestId = onProgress ? crypto.randomUUID() : undefined;
  const unsubscribe =
    onProgress &&
    window.electronAPI.onLocalMcpInstallProgress?.((progress) => {
      if (progress.requestId === requestId) onProgress(progress.phase);
    });
  let result;
  try {
    result = await window.electronAPI.localMcpManage({
      action,
      scope: localMcpScope(),
      requestId,
      ...body,
    });
  } finally {
    unsubscribe?.();
  }
  await syncLocalMcp();
  if (action === 'configure' && body.patch?.env !== undefined && result?.error)
    throw new Error(result.error);
  return result;
}
export const installLocalMcp = (
  input: LocalMcpInput,
  onProgress?: (phase: LocalMcpInstallPhase) => void,
) => localManage('install', { input }, onProgress);
export const updateLocalMcp = (
  id: string,
  onProgress?: (phase: LocalMcpInstallPhase) => void,
  version?: string,
) => localManage('update', { id, version }, onProgress);
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
