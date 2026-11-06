import crypto from 'node:crypto';
import { updateLocalMetadata } from './local.js';
import { sendIpcToDesktop } from '../../ws-clients.js';
import { notifyMcpSettingsUpdated } from '../../ws-clients.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { db } from '../../db.js';
import { mcpHttp, mcpUrl, resolveMcpAddress } from './network.js';
import { credentials, saveCredentials, requireConnection, type McpConnection } from './store.js';

const busy = new Set<number>();
export const activeCalls = new Map<number, { userId: number; controller: AbortController }>();
function callbackUrl() {
  if (!process.env.MCP_CALLBACK_URL) throw new Error('mcp_oauth_callback_not_configured');
  return mcpUrl(process.env.MCP_CALLBACK_URL).href;
}
function provider(
  row: McpConnection,
  state?: string,
  onRedirect?: (url: string) => void,
): OAuthClientProvider {
  let saved = credentials(row);
  const update = (patch: any) => {
    saved = { ...saved, ...patch };
    saveCredentials(row, saved);
  };
  return {
    get redirectUrl() {
      return callbackUrl();
    },
    get clientMetadata() {
      return {
        client_name: 'Chatter',
        redirect_uris: [callbackUrl()],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state: () => state || '',
    clientInformation: () => saved.client,
    saveClientInformation: (client) => update({ client }),
    tokens: () => saved.tokens,
    saveTokens: (tokens) => update({ tokens }),
    saveCodeVerifier: (verifier) => update({ verifier }),
    codeVerifier: () => saved.verifier,
    discoveryState: () => saved.discovery,
    saveDiscoveryState: (discovery) => update({ discovery }),
    redirectToAuthorization: async (url) => {
      await resolveMcpAddress(mcpUrl(url.href));
      if (!onRedirect) throw new Error('mcp_authorization_required');
      onRedirect(url.href);
    },
    invalidateCredentials: (scope) => {
      if (scope === 'all') {
        update({ client: undefined, tokens: undefined, verifier: undefined, discovery: undefined });
        return;
      }
      const key =
        scope === 'verifier'
          ? 'verifier'
          : scope === 'discovery'
            ? 'discovery'
            : scope === 'client'
              ? 'client'
              : 'tokens';
      update({ [key]: undefined });
    },
  };
}
type RuntimeSession = {
  id: number;
  userId: number;
  row: McpConnection;
  controller: AbortController;
  client: Client;
  transport: StreamableHTTPClientTransport;
  idle?: ReturnType<typeof setTimeout>;
};
const sessions = new Map<number, RuntimeSession>();
async function closeSession(entry: RuntimeSession) {
  if (sessions.get(entry.id) === entry) sessions.delete(entry.id);
  if (entry.idle) clearTimeout(entry.idle);
  entry.controller.abort();
  await entry.client.close().catch(() => {});
}
export async function closeMcpSessions() {
  await Promise.all([...sessions.values()].map(closeSession));
}
function keepSession(entry: RuntimeSession) {
  if (entry.idle) clearTimeout(entry.idle);
  sessions.delete(entry.id);
  sessions.set(entry.id, entry);
  entry.idle = setTimeout(() => void closeSession(entry), 600_000);
  entry.idle.unref();
}
async function session<T>(
  userId: number,
  id: number,
  signal: AbortSignal | undefined,
  action: (
    client: Client,
    transport: StreamableHTTPClientTransport,
    row: McpConnection,
  ) => Promise<T>,
  oauth?: { state?: string; redirect?: (url: string) => void; code?: string },
) {
  const row = requireConnection(userId, id);
  signal?.throwIfAborted();
  if (
    busy.has(id) ||
    [...activeCalls.values()].filter((call) => call.userId === userId).length >= 3
  )
    throw new Error('mcp_connection_busy');
  busy.add(id);
  let entry: RuntimeSession | undefined, handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let succeeded = false;
  const abort = () => entry?.controller.abort(signal?.reason);
  try {
    const previous = sessions.get(id);
    if (
      previous &&
      !oauth &&
      previous.userId === userId &&
      previous.row.url === row.url &&
      previous.row.credentials === row.credentials &&
      !previous.controller.signal.aborted &&
      previous.client.transport
    ) {
      entry = previous;
      if (entry.idle) clearTimeout(entry.idle);
    } else {
      if (previous) await closeSession(previous);
      if (!oauth && sessions.size >= 128) {
        const idle = [...sessions.values()].find((item) => !busy.has(item.id));
        if (!idle) throw new Error('mcp_capacity');
        await closeSession(idle);
      }
      const controller = new AbortController();
      const secret = credentials(row);
      const client = new Client({ name: 'chatter', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(row.url), {
        fetch: (input, init) =>
          mcpHttp.fetch(input as any, {
            ...init,
            signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
          }),
        requestInit: secret.bearer
          ? { headers: { Authorization: 'Bearer ' + secret.bearer } }
          : undefined,
        authProvider: secret.bearer ? undefined : provider(row, oauth?.state, oauth?.redirect),
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
      entry = { id, userId, row, controller, client, transport };
      if (!oauth) sessions.set(id, entry);
      handshakeTimer = setTimeout(
        () => controller.abort(new Error('mcp_connection_timeout')),
        30_000,
      );
    }
    activeCalls.set(id, { userId, controller: entry.controller });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (handshakeTimer) {
      if (oauth?.code) await entry.transport.finishAuth(oauth.code);
      await entry.client.connect(entry.transport, {
        timeout: 30_000,
        signal: entry.controller.signal,
      });
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
    requireConnection(userId, id);
    const result = await action(entry.client, entry.transport, row);
    requireConnection(userId, id);
    succeeded = true;
    return result;
  } catch (error) {
    if (entry?.controller.signal.aborted && !signal?.aborted) {
      throw entry.controller.signal.reason instanceof Error
        ? entry.controller.signal.reason
        : new Error('mcp_cancelled');
    }
    throw error;
  } finally {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    signal?.removeEventListener('abort', abort);
    activeCalls.delete(id);
    busy.delete(id);
    if (entry) {
      if (succeeded && !oauth && !entry.controller.signal.aborted) keepSession(entry);
      else await closeSession(entry);
    }
  }
}
async function localOperation(
  userId: number,
  id: number,
  payload: any,
  signal?: AbortSignal,
  onProgress?: () => void,
) {
  const row = requireConnection(userId, id);
  if (
    busy.has(id) ||
    [...activeCalls.values()].filter((call) => call.userId === userId).length >= 3
  )
    throw new Error('mcp_connection_busy');
  const controller = new AbortController();
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  busy.add(id);
  activeCalls.set(id, { userId, controller });
  try {
    const result = await sendIpcToDesktop(
      userId,
      'mcp_control',
      { ...payload, local_id: row.local_id, timeout_seconds: row.timeout_seconds },
      row.timeout_seconds * 1000,
      linked,
      onProgress,
    );
    requireConnection(userId, id);
    return result;
  } finally {
    busy.delete(id);
    activeCalls.delete(id);
  }
}
export async function refreshTools(userId: number, id: number, signal?: AbortSignal) {
  const row = requireConnection(userId, id);
  if (row.transport === 'stdio') {
    const result = await localOperation(userId, id, { action: 'discover' }, signal);
    updateLocalMetadata(userId, row.local_id!, result);
    return JSON.parse(requireConnection(userId, id).tools_json);
  }
  return session(userId, id, signal, async (client, _transport, row) => {
    const advertised = client.getServerCapabilities() || {};
    const capabilities = {
      tools: !!advertised.tools,
      resources: !!advertised.resources,
      prompts: !!advertised.prompts,
    };
    async function pages(
      method: 'tools' | 'resources' | 'templates',
      maximum: number,
    ): Promise<any[]> {
      const result: any[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        if (seen.size >= 20 || seen.has(cursor || '')) throw new Error('mcp_invalid_catalog');
        seen.add(cursor || '');
        let page: any;
        try {
          const params = cursor ? { cursor } : {},
            options = { timeout: 30_000, signal };
          page =
            method === 'tools'
              ? await client.listTools(params, options)
              : method === 'resources'
                ? await client.listResources(params, options)
                : await client.listResourceTemplates(params, options);
        } catch (error: any) {
          if (method !== 'tools' && error?.code === -32601) return [];
          throw error;
        }
        result.push(...(page[method === 'templates' ? 'resourceTemplates' : method] || []));
        if (result.length > maximum || JSON.stringify(result).length > 512_000)
          throw new Error('mcp_catalog_too_large');
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    }
    const tools = capabilities.tools ? await pages('tools', 200) : [];
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
      if (schema.length > 64_000 || /"\$ref"\s*:\s*"(?!#)/.test(schema))
        throw new Error('mcp_invalid_tool_schema');
    }
    const normalize = (item: any, template: boolean) => {
      const locator = template ? item.uriTemplate : item.uri;
      if (typeof locator !== 'string' || locator.length > 4096 || /[\u0000-\u001f]/.test(locator))
        throw new Error('mcp_invalid_resource_catalog');
      if (template) new UriTemplate(locator);
      else new URL(locator);
      return {
        ...(template ? { uriTemplate: locator } : { uri: locator }),
        name: String(item.name || locator).slice(0, 160),
        title: String(item.title || '').slice(0, 160),
        description: String(item.description || '').slice(0, 1500),
        mimeType: String(item.mimeType || '').slice(0, 128),
      };
    };
    const resources = capabilities.resources
      ? (await pages('resources', 500)).map((item) => normalize(item, false))
      : [];
    const templates = capabilities.resources
      ? (await pages('templates', 200)).map((item) => normalize(item, true))
      : [];
    const version = client.getServerVersion() as any;
    const info = version
      ? {
          name: String(version.name || '').slice(0, 160),
          title: String(version.title || '').slice(0, 160),
          version: String(version.version || '').slice(0, 100),
          description: String(version.description || '').slice(0, 1500),
        }
      : null;
    requireConnection(userId, id);
    db.prepare(
      'UPDATE mcp_connections SET tools_json=?,resources_json=?,templates_json=?,capabilities_json=?,server_info_json=?,updated_at=? WHERE id=? AND user_id=?',
    ).run(
      JSON.stringify(tools),
      JSON.stringify(resources),
      JSON.stringify(templates),
      JSON.stringify(capabilities),
      JSON.stringify(info),
      Date.now(),
      id,
      row.user_id,
    );
    notifyMcpSettingsUpdated(userId);
    return tools;
  });
}
export async function callRemoteTool(
  userId: number,
  id: number,
  name: string,
  args: any,
  signal?: AbortSignal,
  onProgress?: () => void,
) {
  if (requireConnection(userId, id).transport === 'stdio')
    return localOperation(
      userId,
      id,
      { action: 'call', tool: name, arguments: args },
      signal,
      onProgress,
    );
  return session(userId, id, signal, async (client, _transport, row) => {
    let lastProgress = 0;
    return client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: row.timeout_seconds * 1000,
      resetTimeoutOnProgress: true,
      onprogress: () => {
        if (Date.now() - lastProgress < 1000) return;
        lastProgress = Date.now();
        try {
          void Promise.resolve(onProgress?.()).catch(() => {});
        } catch {
          /* status callbacks cannot fail a tool call */
        }
      },
    });
  });
}
export async function readRemoteResource(
  userId: number,
  id: number,
  uri: string,
  signal?: AbortSignal,
  onProgress?: () => void,
) {
  if (requireConnection(userId, id).transport === 'stdio')
    return localOperation(userId, id, { action: 'read_resource', uri }, signal, onProgress);
  return session(userId, id, signal, async (client, _transport, row) => {
    if (!client.getServerCapabilities()?.resources) throw new Error('mcp_resources_not_supported');
    let lastProgress = 0;
    return client.readResource(
      { uri },
      {
        signal,
        timeout: row.timeout_seconds * 1000,
        resetTimeoutOnProgress: true,
        onprogress: () => {
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          try {
            void Promise.resolve(onProgress?.()).catch(() => {});
          } catch {}
        },
      },
    );
  });
}
export function cancelCall(userId: number, id: number) {
  const call = activeCalls.get(id);
  if (call?.userId === userId) call.controller.abort(new Error('mcp_cancelled'));
  const cached = sessions.get(id);
  if (cached?.userId === userId) void closeSession(cached);
  return { cancelled: call?.userId === userId };
}
export function cancelForbiddenCalls() {
  for (const entry of sessions.values()) {
    try {
      requireConnection(entry.userId, entry.id);
    } catch {
      entry.controller.abort(new Error('mcp_access_revoked'));
      void closeSession(entry);
    }
  }

  for (const [id, call] of activeCalls) {
    try {
      requireConnection(call.userId, id);
    } catch {
      call.controller.abort(new Error('mcp_access_revoked'));
    }
  }
}
const stateHash = (state: string) => crypto.createHash('sha256').update(state).digest('hex');
export async function beginOAuth(userId: number, id: number) {
  const row = requireConnection(userId, id);
  callbackUrl();
  if (credentials(row).bearer) throw new Error('mcp_remove_token_before_oauth');
  const state = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM mcp_oauth_states WHERE expires_at<? OR connection_id=?').run(
    Date.now(),
    id,
  );
  db.prepare(
    'INSERT INTO mcp_oauth_states(state_hash,user_id,connection_id,expires_at) VALUES(?,?,?,?)',
  ).run(stateHash(state), userId, id, Date.now() + 600_000);
  let authorizationUrl = '';
  try {
    // Force user authorization rather than silently reusing old tokens.
    const secret = credentials(row);
    delete secret.tokens;
    saveCredentials(row, secret);
    await session(userId, id, undefined, async () => ({}), {
      state,
      redirect: (url) => (authorizationUrl = url),
    });
  } catch (error) {
    if (!authorizationUrl) {
      db.prepare('DELETE FROM mcp_oauth_states WHERE state_hash=?').run(stateHash(state));
      throw error;
    }
  }
  if (!authorizationUrl) throw new Error('mcp_oauth_not_required');
  return { authorization_url: authorizationUrl };
}
export async function finishOAuth(state: string, code: string) {
  const hash = stateHash(state);
  const record = db
    .prepare('DELETE FROM mcp_oauth_states WHERE state_hash=? AND expires_at>? RETURNING *')
    .get(hash, Date.now()) as any;
  if (!record || !code || code.length > 8192) throw new Error('mcp_invalid_oauth_state');
  await session(record.user_id, record.connection_id, undefined, async () => ({}), { code } as any);
  await refreshTools(record.user_id, record.connection_id);
}
