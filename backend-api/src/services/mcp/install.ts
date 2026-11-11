import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { notifyMcpSettingsUpdated, sendIpcToDesktop, wsClients } from '../../ws-clients.js';
import { refreshTools } from './client.js';
import { confirmMcpAction, type McpApprovalContext } from './confirmations.js';
import { getLocalConnections } from './local.js';
import { mcpUrl } from './network.js';
import {
  allServers,
  connections,
  policy,
  requireConnection,
  requireMcpAccount,
  saveConnection,
} from './store.js';
import { wrapUntrustedContent } from '../web-reader.js';

export function canInstallMcp(userId: number) {
  const access = policy(userId);
  return access.enabled && (access.allow_custom || access.show_catalog);
}

export function browseInstallCatalog(userId: number, query: unknown) {
  requireMcpAccount(userId);
  const access = policy(userId);
  if (!access.enabled || !access.show_catalog) throw new Error('mcp_catalog_hidden');
  const words = String(query || '')
    .slice(0, 120)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const items = allServers()
    .filter((row) => row.allowed && (row.transport !== 'stdio' || access.allow_custom))
    .filter((row) =>
      words.every((word) => (row.name + ' ' + row.description).toLowerCase().includes(word)),
    )
    .slice(0, 20)
    .map(({ id, name, description, transport }) => ({
      catalog_id: id,
      name,
      description,
      transport,
    }));
  return { items };
}

function installPlan(userId: number, input: any) {
  requireMcpAccount(userId);
  const access = policy(userId);
  if (!access.enabled) throw new Error('mcp_disabled');
  if (!input || typeof input !== 'object' || JSON.stringify(input).length > 8000)
    throw new Error('mcp_invalid_install_input');
  if (input.catalog_id !== undefined) {
    if (!access.show_catalog || !Number.isSafeInteger(input.catalog_id))
      throw new Error('mcp_catalog_hidden');
    const row = allServers().find((item) => item.id === input.catalog_id && item.allowed);
    if (!row || (row.transport === 'stdio' && !access.allow_custom))
      throw new Error('mcp_server_not_allowed');
    return {
      name: row.name,
      catalogId: row.id,
      source: row.source,
      url: row.url,
      documentation: '',
    };
  }
  if (!access.allow_custom) throw new Error('mcp_custom_not_allowed');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120 || /[\x00-\x1f]/.test(name))
    throw new Error('mcp_invalid_install_input');
  let documentation: string;
  try {
    const docs = new URL(input.documentation);
    if (docs.protocol !== 'https:' || docs.username || docs.password || docs.search)
      throw new Error();
    documentation = docs.href;
  } catch {
    throw new Error('mcp_invalid_install_source');
  }
  if (input.url !== undefined) {
    if (input.command !== undefined || input.args !== undefined)
      throw new Error('mcp_invalid_install_input');
    return { name, documentation, url: mcpUrl(input.url).href, source: '' };
  }
  if (
    !['npx', 'uvx'].includes(input.command) ||
    !Array.isArray(input.args) ||
    !input.args.length ||
    input.args.some((arg: unknown) => typeof arg !== 'string' || /[\x00-\x1f]/.test(arg))
  )
    throw new Error('mcp_invalid_install_input');
  return {
    name,
    documentation,
    url: '',
    source: JSON.stringify({ command: input.command, args: input.args }),
  };
}

export async function installMcp(
  userId: number,
  input: any,
  signal?: AbortSignal,
  context?: McpApprovalContext,
) {
  const captured = JSON.parse(JSON.stringify(input));
  const plan = installPlan(userId, captured);
  const desktop = plan.source ? wsClients.get(userId) : undefined;
  if (plan.source && desktop?.ws.readyState !== 1) throw new Error('mcp_desktop_not_connected');
  const checkPlan = () => {
    if (JSON.stringify(installPlan(userId, captured)) !== JSON.stringify(plan))
      throw new Error('mcp_confirmation_stale');
  };
  const connectRemote = async (connectionId: number) => {
    const tools = await refreshTools(userId, connectionId, signal);
    return JSON.stringify({ status: 'connected', connection_id: connectionId, tools: tools.length });
  };
  const installLocal = async (reportPhase: (phase: string) => void, values?: Record<string, string>) => {
    checkPlan();
    if (wsClients.get(userId) !== desktop) throw new Error('mcp_desktop_connection_changed');
    const result = await sendIpcToDesktop(
      userId,
      'mcp_control',
      {
        action: 'install',
        input: {
          source: plan.source,
          name: plan.name,
          catalog_id: plan.catalogId,
          reuse_existing: true,
          ...(values && { values }),
        },
      },
      20 * 60_000,
      signal,
      (phase) => {
        if (phase === 'installing' || phase === 'connecting') reportPhase(phase);
      },
    );
    // Desktop sends its local snapshot over the same socket before returning the IPC result.
    const registered = getLocalConnections(userId).find((row) => row.local_id === result.id);
    const connection = registered && requireConnection(userId, registered.id, false);
    return JSON.stringify({
      status: !connection
        ? 'installed_sync_failed'
        : result.error
          ? 'installed_connection_failed'
          : result.reused
            ? 'already_connected'
            : 'connected',
      ...(connection
        ? { connection_id: connection.id }
        : {
            error: 'mcp_local_sync_failed',
            instruction:
              'The local installation is saved. After desktop sync, use browse_mcp to find its connection_id. Do not reinstall to recover the ID.',
          }),
      local_id: result.id,
      version: result.installed_version,
      tools: result.tool_count,
      resources: result.resource_count,
      ...(result.error && (values
        ? { instruction: 'See the connection diagnostics in MCP settings.' }
        : { diagnostic: wrapUntrustedContent(String(result.error).slice(0, 2000)) })),
    });
  };
  let authorizationId: number | undefined;
  let needsLocalConfiguration = false;
  const result = await confirmMcpAction(
    userId,
    {
      operation: 'install',
      target: plan.source ? 'stdio' : 'streamable-http',
      arguments: {
        ...(plan.source ? { command: plan.source } : { url: plan.url }),
        ...(plan.documentation && { documentation: plan.documentation }),
      },
    },
    plan.name,
    async (_remember, reportPhase) => {
      checkPlan();
      if (plan.source) {
        try {
          return await installLocal(reportPhase);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'mcp_required_configuration')
            throw error;
          needsLocalConfiguration = true;
          return JSON.stringify({ status: 'configuration_required' });
        }
      }
      reportPhase('connecting');
      const existing = connections(userId).find(
        (row) =>
          row.transport !== 'stdio' &&
          row.url === plan.url &&
          (row.server_id ?? undefined) === plan.catalogId,
      );
      const connection =
        existing ||
        saveConnection(userId, {
          name: plan.name,
          url: plan.url,
          server_id: plan.catalogId,
          reuse_existing: true,
        });
      notifyMcpSettingsUpdated(userId);
      try {
        return await connectRemote(connection.id);
      } catch (error) {
        signal?.throwIfAborted();
        const code = error instanceof Error ? error.message : '';
        if (
          code === 'mcp_authorization_required' || code.startsWith('mcp_oauth_') ||
          error instanceof UnauthorizedError ||
          (error instanceof StreamableHTTPError && error.code === 401)
        )
          authorizationId = connection.id;
        return JSON.stringify({
          status: 'configured_connection_failed',
          connection_id: connection.id,
          error: /^mcp_[a-z_]+$/.test(code) ? code : 'mcp_request_failed',
          instruction:
            'The connection is saved. If it requires credentials, the user can sign in from MCP settings.',
        });
      }
    },
    signal,
    context,
  );
  if (needsLocalConfiguration)
    return confirmMcpAction(
      userId,
      { operation: 'install_config', target: 'stdio', arguments: { source: plan.source } },
      plan.name,
      async (_remember, reportPhase, values) => {
        if (!values) throw new Error('mcp_required_configuration');
        try {
          return await installLocal(reportPhase, values);
        } catch (error) {
          signal?.throwIfAborted();
          const code = error instanceof Error ? error.message : '';
          throw new Error(/^mcp_[a-z_]+$/.test(code) ? code : 'mcp_local_install_failed');
        }
      },
      signal,
      context,
    );
  if (authorizationId !== undefined) {
    const id = authorizationId;
    return confirmMcpAction(
      userId,
      { operation: 'authorize', target: plan.url, connection_id: id, arguments: {} },
      plan.name,
      async () => {
        checkPlan();
        return connectRemote(id);
      },
      signal,
      context,
    );
  }
  return result;
}
