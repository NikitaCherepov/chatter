import crypto from 'node:crypto';
import { db } from '../../db.js';
import { getEncryptionKey } from '../../utils/encryption.js';
import { mcpUrl } from './network.js';

export type McpServer = {
  id: number;
  name: string;
  url: string;
  description: string;
  allowed: number;
  recommended: number;
};
export type McpConnection = {
  id: number;
  user_id: number;
  server_id: number | null;
  name: string;
  url: string;
  enabled: number;
  mode: 'eager' | 'search';
  timeout_seconds: number;
  credentials: string | null;
  tools_json: string;
  selected_tools: string;
  updated_at: number;
};
export const allServers = () =>
  db.prepare('SELECT * FROM mcp_servers ORDER BY recommended DESC,name,id').all() as McpServer[];
export const connections = (userId: number) =>
  db
    .prepare('SELECT * FROM mcp_connections WHERE user_id=? ORDER BY id')
    .all(userId) as McpConnection[];
export function policy(userId?: number) {
  const global = db.prepare('SELECT * FROM mcp_policy WHERE id=1').get() as any;
  const personal = userId
    ? (db.prepare('SELECT * FROM mcp_user_policy WHERE user_id=?').get(userId) as any)
    : null;
  return {
    enabled: !!global.enabled,
    allow_custom: personal?.allow_custom == null ? !!global.allow_custom : !!personal.allow_custom,
    override: personal?.allow_custom == null ? 'inherit' : personal.allow_custom ? 'allow' : 'deny',
  };
}
export function savePolicy(body: any, userId?: number) {
  if (userId) {
    if (!['inherit', 'allow', 'deny'].includes(body.override))
      throw new Error('mcp_invalid_policy');
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId))
      throw new Error('mcp_user_not_found');
    db.prepare(
      'INSERT INTO mcp_user_policy(user_id,allow_custom) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET allow_custom=excluded.allow_custom',
    ).run(userId, body.override === 'inherit' ? null : body.override === 'allow' ? 1 : 0);
  } else {
    if (typeof body.enabled !== 'boolean' || typeof body.allow_custom !== 'boolean')
      throw new Error('mcp_invalid_policy');
    db.prepare('UPDATE mcp_policy SET enabled=?,allow_custom=? WHERE id=1').run(
      +body.enabled,
      +body.allow_custom,
    );
  }
  return policy(userId);
}
export function saveServer(body: any, id?: number) {
  const url = mcpUrl(body.url).href;
  const name = String(body.name || '')
    .trim()
    .slice(0, 120);
  if (!name || typeof body.allowed !== 'boolean' || typeof body.recommended !== 'boolean')
    throw new Error('mcp_invalid_server');
  const args = [
    name,
    url,
    String(body.description || '').slice(0, 1500),
    +body.allowed,
    +body.recommended,
  ];
  if (id) {
    if (!allServers().some((server) => server.id === id)) throw new Error('mcp_server_not_found');
    // Connections and credentials are bound to the exact URL. An edit must not redirect existing secrets.
    db.prepare(
      'UPDATE mcp_servers SET name=?,url=?,description=?,allowed=?,recommended=? WHERE id=?',
    ).run(...args, id);
  } else
    id = Number(
      db
        .prepare(
          'INSERT INTO mcp_servers(name,url,description,allowed,recommended) VALUES(?,?,?,?,?)',
        )
        .run(...args).lastInsertRowid,
    );
  return allServers().find((server) => server.id === id)!;
}
export function deleteServer(id: number) {
  db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id);
}
export function requireConnection(userId: number, id: number, enabled = true) {
  const user = db.prepare('SELECT status,feature_flags FROM users WHERE id=?').get(userId) as any;
  if (!user || user.status !== 'approved') throw new Error('mcp_not_allowed');
  try {
    if (JSON.parse(user.feature_flags || '{}').disable_internet) throw new Error('mcp_not_allowed');
  } catch (error) {
    if ((error as Error).message === 'mcp_not_allowed') throw error;
  }
  const row = connections(userId).find((connection) => connection.id === id);
  if (!row) throw new Error('mcp_connection_not_found');
  const access = policy(userId);
  if (!access.enabled) throw new Error('mcp_disabled');
  if (enabled && !row.enabled) throw new Error('mcp_connection_disabled');
  if (row.server_id != null) {
    const server = allServers().find((server) => server.id === row.server_id);
    if (!server?.allowed || server.url !== row.url) throw new Error('mcp_server_not_allowed');
  } else if (!access.allow_custom) throw new Error('mcp_custom_not_allowed');
  return row;
}
export const availableConnections = (userId: number) =>
  connections(userId).filter((row) => {
    try {
      requireConnection(userId, row.id);
      return true;
    } catch {
      return false;
    }
  });
function seal(value: unknown) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function credentials(row: McpConnection): any {
  if (!row.credentials) return {};
  const data = Buffer.from(row.credentials, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(['ENCRYPTION_KEY']),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(),
  );
}
export function saveCredentials(row: McpConnection, value: any) {
  const encrypted = seal(value);
  const result = db
    .prepare(
      'UPDATE mcp_connections SET credentials=?,updated_at=? WHERE id=? AND user_id=? AND credentials IS ?',
    )
    .run(encrypted, Date.now(), row.id, row.user_id, row.credentials);
  if (!result.changes) throw new Error('mcp_connection_changed');
  row.credentials = encrypted;
}
export function publicConnection(row: McpConnection) {
  const { credentials: secret, tools_json, selected_tools, ...rest } = row;
  let blocked = false;
  try {
    requireConnection(row.user_id, row.id, false);
  } catch {
    blocked = true;
  }
  return {
    ...rest,
    blocked,
    has_credentials: !!secret,
    tools: JSON.parse(tools_json),
    selected_tools: JSON.parse(selected_tools),
  };
}
export function saveConnection(userId: number, body: any, id?: number) {
  const current = id ? connections(userId).find((row) => row.id === id) : null;
  if (id && !current) throw new Error('mcp_connection_not_found');
  if (!id && connections(userId).length >= 20) throw new Error('mcp_connection_limit');
  const serverId = current
    ? current.server_id
    : body.server_id == null
      ? null
      : Number(body.server_id);
  const server = serverId == null ? null : allServers().find((row) => row.id === serverId);
  if (!current && server && body.url !== undefined && mcpUrl(body.url).href !== server.url) {
    throw new Error('mcp_server_changed');
  }
  const url = current?.url || server?.url || mcpUrl(body.url).href;
  const access = policy(userId);
  if (
    !access.enabled ||
    (serverId != null ? !server?.allowed || server.url !== url : !access.allow_custom)
  )
    throw new Error('mcp_not_allowed');
  const name = String(body.name ?? current?.name ?? server?.name ?? '')
    .trim()
    .slice(0, 120);
  const mode = body.mode ?? current?.mode ?? 'search';
  const timeout = Number(body.timeout_seconds ?? current?.timeout_seconds ?? 300);
  if (
    !name ||
    !['eager', 'search'].includes(mode) ||
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 3600
  )
    throw new Error('mcp_invalid_connection');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    throw new Error('mcp_invalid_connection');
  let selected =
    body.selected_tools === undefined
      ? JSON.parse(current?.selected_tools || 'null')
      : body.selected_tools;
  if (
    selected !== null &&
    (!Array.isArray(selected) ||
      selected.length > 200 ||
      selected.some((item) => typeof item !== 'string' || item.length > 128))
  )
    throw new Error('mcp_invalid_tools');
  let secret = current?.credentials || null;
  if (body.token !== undefined) {
    if (current) db.prepare('DELETE FROM mcp_oauth_states WHERE connection_id=?').run(current.id);
    if (typeof body.token !== 'string' || body.token.length > 8192 || /[\r\n]/.test(body.token))
      throw new Error('mcp_invalid_token');
    secret = body.token ? seal({ bearer: body.token }) : null;
  }
  const args = [
    name,
    mode,
    timeout,
    body.enabled === undefined ? (current?.enabled ?? 1) : +body.enabled,
    JSON.stringify(selected),
    secret,
    Date.now(),
  ];
  if (current)
    db.prepare(
      'UPDATE mcp_connections SET name=?,mode=?,timeout_seconds=?,enabled=?,selected_tools=?,credentials=?,updated_at=? WHERE id=? AND user_id=?',
    ).run(...args, id, userId);
  else
    id = Number(
      db
        .prepare(
          'INSERT INTO mcp_connections(name,mode,timeout_seconds,enabled,selected_tools,credentials,updated_at,user_id,server_id,url) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(...args, userId, serverId, url).lastInsertRowid,
    );
  return publicConnection(connections(userId).find((row) => row.id === id)!);
}
export function deleteConnection(userId: number, id: number) {
  db.prepare('DELETE FROM mcp_connections WHERE user_id=? AND id=?').run(userId, id);
}
