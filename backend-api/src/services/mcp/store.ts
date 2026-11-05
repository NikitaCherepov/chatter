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
  resources_json: string;
  templates_json: string;
  capabilities_json: string | null;
  server_info_json: string | null;
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
    show_catalog: personal?.show_catalog == null ? !!global.show_catalog : !!personal.show_catalog,
    catalog_override:
      personal?.show_catalog == null ? 'inherit' : personal.show_catalog ? 'allow' : 'deny',
    allow_custom: personal?.allow_custom == null ? !!global.allow_custom : !!personal.allow_custom,
    override: personal?.allow_custom == null ? 'inherit' : personal.allow_custom ? 'allow' : 'deny',
  };
}
export function savePolicy(body: any, userId?: number) {
  if (userId) {
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId))
      throw new Error('mcp_user_not_found');
    if (body.override === undefined && body.catalog_override === undefined)
      throw new Error('mcp_invalid_policy');
    const current = db.prepare('SELECT * FROM mcp_user_policy WHERE user_id=?').get(userId) as any;
    const normalize = (value: unknown, previous: number | null | undefined) => {
      if (value === undefined) return previous ?? null;
      if (!['inherit', 'allow', 'deny'].includes(String(value)))
        throw new Error('mcp_invalid_policy');
      return value === 'inherit' ? null : value === 'allow' ? 1 : 0;
    };
    db.prepare(
      'INSERT INTO mcp_user_policy(user_id,allow_custom,show_catalog) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET allow_custom=excluded.allow_custom,show_catalog=excluded.show_catalog',
    ).run(
      userId,
      normalize(body.override, current?.allow_custom),
      normalize(body.catalog_override, current?.show_catalog),
    );
  } else {
    if (
      !['enabled', 'allow_custom', 'show_catalog'].some((key) => body[key] !== undefined) ||
      ['enabled', 'allow_custom', 'show_catalog'].some(
        (key) => body[key] !== undefined && typeof body[key] !== 'boolean',
      )
    )
      throw new Error('mcp_invalid_policy');
    const current = db.prepare('SELECT * FROM mcp_policy WHERE id=1').get() as any;
    db.prepare('UPDATE mcp_policy SET enabled=?,allow_custom=?,show_catalog=? WHERE id=1').run(
      body.enabled === undefined ? current.enabled : +body.enabled,
      body.allow_custom === undefined ? current.allow_custom : +body.allow_custom,
      body.show_catalog === undefined ? current.show_catalog : +body.show_catalog,
    );
  }
  return policy(userId);
}
export type McpAccessRule = {
  mode: 'all' | 'selected' | 'none';
  user_ids: number[];
  excluded_user_ids: number[];
};
const accessColumns = ['allow_custom', 'show_catalog'] as const;
export function accessSettings(): Record<(typeof accessColumns)[number], McpAccessRule> {
  const global = db.prepare('SELECT * FROM mcp_policy WHERE id=1').get() as any;
  const personal = db.prepare('SELECT * FROM mcp_user_policy ORDER BY user_id').all() as any[];
  return Object.fromEntries(
    accessColumns.map((column) => {
      const allowed = personal.filter((row) => row[column] === 1).map((row) => row.user_id);
      return [
        column,
        {
          mode: global[column] ? 'all' : allowed.length ? 'selected' : 'none',
          user_ids: global[column] ? [] : allowed,
          excluded_user_ids: global[column]
            ? personal.filter((row) => row[column] === 0).map((row) => row.user_id)
            : [],
        },
      ];
    }),
  ) as Record<(typeof accessColumns)[number], McpAccessRule>;
}
export function saveAccessSettings(body: any) {
  if (!body || !accessColumns.some((column) => body[column] !== undefined))
    throw new Error('mcp_invalid_policy');
  const normalizeIds = (ids: unknown) => {
    if (
      !Array.isArray(ids) ||
      ids.length > 10000 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new Error('mcp_invalid_policy');
    const result = [...new Set(ids)] as number[];
    const find = db.prepare('SELECT id FROM users WHERE id=?');
    if (result.some((id) => !find.get(id))) throw new Error('mcp_user_not_found');
    return result;
  };
  const changes = accessColumns
    .filter((column) => body[column] !== undefined)
    .map((column) => {
      const rule = body[column];
      if (!rule || !['all', 'selected', 'none'].includes(rule.mode))
        throw new Error('mcp_invalid_policy');
      return {
        column,
        mode: rule.mode,
        ids: normalizeIds(
          rule.mode === 'selected'
            ? (rule.user_ids ?? [])
            : rule.mode === 'all'
              ? (rule.excluded_user_ids ?? [])
              : [],
        ),
      };
    });
  db.transaction(() => {
    for (const { column, mode, ids } of changes) {
      db.prepare('UPDATE mcp_policy SET ' + column + '=? WHERE id=1').run(mode === 'all' ? 1 : 0);
      db.prepare('UPDATE mcp_user_policy SET ' + column + '=NULL').run();
      const write = db.prepare(
        'INSERT INTO mcp_user_policy(user_id,' +
          column +
          ') VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET ' +
          column +
          '=excluded.' +
          column,
      );
      for (const id of ids) write.run(id, mode === 'all' ? 0 : 1);
    }
  })();
  return accessSettings();
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
  const {
    credentials: secret,
    tools_json,
    resources_json,
    templates_json,
    capabilities_json,
    server_info_json,
    selected_tools,
    ...rest
  } = row;
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
    resources: JSON.parse(resources_json || '[]'),
    resource_templates: JSON.parse(templates_json || '[]'),
    capabilities: capabilities_json ? JSON.parse(capabilities_json) : null,
    server_info: server_info_json ? JSON.parse(server_info_json) : null,
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
  if (!current && serverId != null && !policy(userId).show_catalog)
    throw new Error('mcp_catalog_hidden');
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
