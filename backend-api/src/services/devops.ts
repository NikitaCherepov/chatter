import crypto from 'node:crypto';
import { db, getNowUnix } from '../db.js';

// ── Encryption (same pattern as map-pins.ts) ────────────────────────────────

const ENCRYPTION_KEY_SOURCE = process.env.DEVOPS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || 'dev-default-key-change-in-prod';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_SOURCE).digest();
const IV_LENGTH = 16;
const DELIMITER = ':';

const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${DELIMITER}${encrypted.toString('hex')}`;
};

const decrypt = (text: string): string => {
  const parts = text.split(DELIMITER);
  if (parts.length !== 2) return text;
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
};

// ── Types ───────────────────────────────────────────────────────────────────

export type DevopsServer = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  has_key: boolean;
  has_sudo_password: boolean;
  created_at: number;
  updated_at: number;
};

/** Full creds — only available inside backend, never sent to client or AI */
export type ServerCreds = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  sudoPassword?: string;
};

type DevopsServerRow = {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password_enc: string | null;
  private_key_enc: string | null;
  sudo_password_enc: string | null;
  created_at: number;
  updated_at: number;
};

// ── Ensure table ────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS devops_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    password_enc TEXT,
    private_key_enc TEXT,
    sudo_password_enc TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_devops_servers_user ON devops_servers(user_id)');

// Safe migration for existing tables
try { db.exec('ALTER TABLE devops_servers ADD COLUMN sudo_password_enc TEXT'); } catch {}

// ── Limits ──────────────────────────────────────────────────────────────────

const SERVERS_PER_USER = 10;

// ── Helpers ─────────────────────────────────────────────────────────────────

const rowToDto = (row: DevopsServerRow): DevopsServer => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: row.port,
  username: row.username,
  has_password: !!row.password_enc,
  has_key: !!row.private_key_enc,
  has_sudo_password: !!row.sudo_password_enc,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

// ── CRUD ────────────────────────────────────────────────────────────────────

export const listServers = (userId: number): DevopsServer[] => {
  const rows = db.prepare(`
    SELECT * FROM devops_servers WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId) as DevopsServerRow[];
  return rows.map(rowToDto);
};

export const getServerById = (userId: number, serverId: number): DevopsServer | null => {
  const row = db.prepare(`
    SELECT * FROM devops_servers WHERE user_id = ? AND id = ?
  `).get(userId, serverId) as DevopsServerRow | undefined;
  return row ? rowToDto(row) : null;
};

/** Returns decrypted creds — use only in ssh.ts, never expose to API */
export const getServerCreds = (userId: number, serverId: number): ServerCreds | null => {
  const row = db.prepare(`
    SELECT * FROM devops_servers WHERE user_id = ? AND id = ?
  `).get(userId, serverId) as DevopsServerRow | undefined;
  if (!row) return null;

  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password_enc ? decrypt(row.password_enc) : undefined,
    privateKey: row.private_key_enc ? decrypt(row.private_key_enc) : undefined,
    sudoPassword: row.sudo_password_enc ? decrypt(row.sudo_password_enc) : undefined,
  };
};

export const createServer = (
  userId: number,
  name: string,
  host: string,
  port: number,
  username: string,
  password?: string,
  privateKey?: string,
  sudoPassword?: string,
): { ok: true; id: number } | { ok: false; error: string } => {
  // Validation
  const trimmedName = name.trim();
  const trimmedHost = host.trim();
  const trimmedUsername = username.trim();

  if (!trimmedName) return { ok: false, error: 'name_required' };
  if (!trimmedHost) return { ok: false, error: 'host_required' };
  if (!trimmedUsername) return { ok: false, error: 'username_required' };
  if (!port || port < 1 || port > 65535) return { ok: false, error: 'invalid_port' };
  if (!password && !privateKey) return { ok: false, error: 'auth_required' };

  // Limit check
  const count = db.prepare('SELECT COUNT(*) as cnt FROM devops_servers WHERE user_id = ?')
    .get(userId) as { cnt: number };
  if (count.cnt >= SERVERS_PER_USER) return { ok: false, error: 'servers_limit' };

  const now = getNowUnix();
  const passwordEnc = password ? encrypt(password) : null;
  const privateKeyEnc = privateKey ? encrypt(privateKey) : null;
  const sudoPasswordEnc = sudoPassword ? encrypt(sudoPassword) : null;

  const result = db.prepare(`
    INSERT INTO devops_servers (user_id, name, host, port, username, password_enc, private_key_enc, sudo_password_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, trimmedName, trimmedHost, port, trimmedUsername, passwordEnc, privateKeyEnc, sudoPasswordEnc, now, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const updateServer = (
  userId: number,
  serverId: number,
  updates: {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string;
    sudoPassword?: string;
  },
): { ok: true } | { ok: false; error: string } => {
  const existing = db.prepare('SELECT * FROM devops_servers WHERE user_id = ? AND id = ?')
    .get(userId, serverId) as DevopsServerRow | undefined;
  if (!existing) return { ok: false, error: 'not_found' };

  const now = getNowUnix();
  const setClauses: string[] = ['updated_at = ?'];
  const values: any[] = [now];

  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (!trimmed) return { ok: false, error: 'name_required' };
    setClauses.push('name = ?');
    values.push(trimmed);
  }
  if (updates.host !== undefined) {
    const trimmed = updates.host.trim();
    if (!trimmed) return { ok: false, error: 'host_required' };
    setClauses.push('host = ?');
    values.push(trimmed);
  }
  if (updates.port !== undefined) {
    if (updates.port < 1 || updates.port > 65535) return { ok: false, error: 'invalid_port' };
    setClauses.push('port = ?');
    values.push(updates.port);
  }
  if (updates.username !== undefined) {
    const trimmed = updates.username.trim();
    if (!trimmed) return { ok: false, error: 'username_required' };
    setClauses.push('username = ?');
    values.push(trimmed);
  }
  if (updates.password !== undefined) {
    setClauses.push('password_enc = ?');
    values.push(updates.password ? encrypt(updates.password) : null);
  }
  if (updates.privateKey !== undefined) {
    setClauses.push('private_key_enc = ?');
    values.push(updates.privateKey ? encrypt(updates.privateKey) : null);
  }
  if (updates.sudoPassword !== undefined) {
    setClauses.push('sudo_password_enc = ?');
    values.push(updates.sudoPassword ? encrypt(updates.sudoPassword) : null);
  }

  values.push(userId, serverId);
  db.prepare(`UPDATE devops_servers SET ${setClauses.join(', ')} WHERE user_id = ? AND id = ?`).run(...values);
  return { ok: true };
};

export const deleteServer = (userId: number, serverId: number): boolean => {
  return db.prepare('DELETE FROM devops_servers WHERE user_id = ? AND id = ?')
    .run(userId, serverId).changes > 0;
};

// ── Policies (auto-approve patterns) ────────────────────────────────────────

export type DevopsPolicy = {
  id: number;
  server_id: number;
  pattern: string;
  auto_approve: boolean;
  created_at: number;
};

type DevopsPolicyRow = {
  id: number;
  server_id: number;
  pattern: string;
  auto_approve: number;
  created_at: number;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS devops_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    pattern TEXT NOT NULL,
    auto_approve INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (server_id) REFERENCES devops_servers(id) ON DELETE CASCADE
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_devops_policies_server ON devops_policies(server_id)');

const policyRowToDto = (row: DevopsPolicyRow): DevopsPolicy => ({
  id: row.id,
  server_id: row.server_id,
  pattern: row.pattern,
  auto_approve: row.auto_approve === 1,
  created_at: row.created_at,
});

export const listPolicies = (userId: number, serverId: number): DevopsPolicy[] => {
  // Verify server ownership
  const server = db.prepare('SELECT id FROM devops_servers WHERE user_id = ? AND id = ?')
    .get(userId, serverId) as { id: number } | undefined;
  if (!server) return [];

  const rows = db.prepare('SELECT * FROM devops_policies WHERE server_id = ? ORDER BY created_at DESC')
    .all(serverId) as DevopsPolicyRow[];
  return rows.map(policyRowToDto);
};

export const createPolicy = (
  userId: number,
  serverId: number,
  pattern: string,
  autoApprove: boolean,
): { ok: true; id: number } | { ok: false; error: string } => {
  const server = db.prepare('SELECT id FROM devops_servers WHERE user_id = ? AND id = ?')
    .get(userId, serverId) as { id: number } | undefined;
  if (!server) return { ok: false, error: 'not_found' };

  const trimmed = pattern.trim();
  if (!trimmed) return { ok: false, error: 'pattern_required' };

  // Validate regex
  try { new RegExp(trimmed); } catch { return { ok: false, error: 'invalid_pattern' }; }

  const now = getNowUnix();
  const result = db.prepare(
    'INSERT INTO devops_policies (server_id, pattern, auto_approve, created_at) VALUES (?, ?, ?, ?)'
  ).run(serverId, trimmed, autoApprove ? 1 : 0, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const deletePolicy = (userId: number, policyId: number): boolean => {
  // Verify ownership through server
  const policy = db.prepare(
    `SELECT p.id, s.user_id FROM devops_policies p
     JOIN devops_servers s ON s.id = p.server_id
     WHERE p.id = ? AND s.user_id = ?`
  ).get(policyId, userId) as { id: number; user_id: number } | undefined;
  if (!policy) return false;

  return db.prepare('DELETE FROM devops_policies WHERE id = ?').run(policyId).changes > 0;
};

/** Check if a command matches any auto-approve policy for a server */
export const isAutoApproved = (userId: number, serverId: number, command: string): boolean => {
  const policies = db.prepare(
    `SELECT p.pattern, p.auto_approve FROM devops_policies p
     JOIN devops_servers s ON s.id = p.server_id
     WHERE s.user_id = ? AND s.id = ? AND p.auto_approve = 1`
  ).all(userId, serverId) as Array<{ pattern: string; auto_approve: number }>;

  for (const policy of policies) {
    try {
      const regex = new RegExp(policy.pattern);
      if (regex.test(command)) return true;
    } catch { /* skip invalid patterns */ }
  }
  return false;
};

// ── Runbooks (instruction manuals for DevOps tasks) ─────────────────────────

export type DevopsRunbook = {
  id: number;
  user_id: number;
  title: string;
  content: string;
  commands: string[];
  created_at: number;
  updated_at: number;
};

type DevopsRunbookRow = {
  id: number;
  user_id: number;
  title: string;
  content: string;
  commands: string;
  created_at: number;
  updated_at: number;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS devops_runbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    commands TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Safe migration for existing tables
try { db.exec("ALTER TABLE devops_runbooks ADD COLUMN commands TEXT NOT NULL DEFAULT '[]'"); } catch {}

db.exec('CREATE INDEX IF NOT EXISTS idx_devops_runbooks_user ON devops_runbooks(user_id)');

const RUNBOOKS_LIMIT = 20;

const runbookRowToDto = (row: DevopsRunbookRow): DevopsRunbook => ({
  id: row.id,
  user_id: row.user_id,
  title: row.title,
  content: row.content,
  commands: JSON.parse(row.commands || '[]'),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const listRunbooks = (userId: number): DevopsRunbook[] => {
  const rows = db.prepare('SELECT * FROM devops_runbooks WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as DevopsRunbookRow[];
  return rows.map(runbookRowToDto);
};

export const getRunbookById = (userId: number, runbookId: number): DevopsRunbook | null => {
  const row = db.prepare('SELECT * FROM devops_runbooks WHERE user_id = ? AND id = ?')
    .get(userId, runbookId) as DevopsRunbookRow | undefined;
  return row ? runbookRowToDto(row) : null;
};

export const createRunbook = (
  userId: number,
  title: string,
  content: string,
  commands: string[] = [],
): { ok: true; id: number } | { ok: false; error: string } => {
  const trimmedTitle = title.trim();
  const trimmedContent = content.trim();

  if (!trimmedTitle) return { ok: false, error: 'title_required' };
  if (!trimmedContent) return { ok: false, error: 'content_required' };

  const count = db.prepare('SELECT COUNT(*) as cnt FROM devops_runbooks WHERE user_id = ?')
    .get(userId) as { cnt: number };
  if (count.cnt >= RUNBOOKS_LIMIT) return { ok: false, error: 'runbooks_limit' };

  const now = getNowUnix();
  const result = db.prepare(
    'INSERT INTO devops_runbooks (user_id, title, content, commands, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, trimmedTitle, trimmedContent, JSON.stringify(commands), now, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const updateRunbook = (
  userId: number,
  runbookId: number,
  updates: { title?: string; content?: string; commands?: string[] },
): { ok: true } | { ok: false; error: string } => {
  const existing = db.prepare('SELECT * FROM devops_runbooks WHERE user_id = ? AND id = ?')
    .get(userId, runbookId) as DevopsRunbookRow | undefined;
  if (!existing) return { ok: false, error: 'not_found' };

  const now = getNowUnix();
  const title = updates.title !== undefined ? updates.title.trim() : existing.title;
  const content = updates.content !== undefined ? updates.content.trim() : existing.content;
  const commands = updates.commands !== undefined ? JSON.stringify(updates.commands) : existing.commands;

  if (!title) return { ok: false, error: 'title_required' };
  if (!content) return { ok: false, error: 'content_required' };

  db.prepare('UPDATE devops_runbooks SET title = ?, content = ?, commands = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(title, content, commands, now, runbookId, userId);

  return { ok: true };
};

export const deleteRunbook = (userId: number, runbookId: number): boolean => {
  return db.prepare('DELETE FROM devops_runbooks WHERE user_id = ? AND id = ?')
    .run(userId, runbookId).changes > 0;
};

/** Attach a runbook to a server — creates auto-approve policies for each command */
export const attachRunbookToServer = (
  userId: number,
  serverId: number,
  runbookId: number,
): { ok: true; created: number } | { ok: false; error: string } => {
  // Verify server ownership
  const server = db.prepare('SELECT id FROM devops_servers WHERE user_id = ? AND id = ?')
    .get(userId, serverId) as { id: number } | undefined;
  if (!server) return { ok: false, error: 'server_not_found' };

  const runbook = db.prepare('SELECT * FROM devops_runbooks WHERE user_id = ? AND id = ?')
    .get(userId, runbookId) as DevopsRunbookRow | undefined;
  if (!runbook) return { ok: false, error: 'runbook_not_found' };

  const commands: string[] = JSON.parse(runbook.commands || '[]');
  const now = getNowUnix();
  let created = 0;

  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;

    // Create safe pattern: escape special chars, allow arguments
    const pattern = `^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\.\\\*/g, '[^&;|\\n]+')}[^&;|\\n]*$`;

    // Check if this pattern already exists for this server
    const existing = db.prepare(
      'SELECT id FROM devops_policies WHERE server_id = ? AND pattern = ?'
    ).get(serverId, pattern) as { id: number } | undefined;

    if (!existing) {
      db.prepare(
        'INSERT INTO devops_policies (server_id, pattern, auto_approve, created_at) VALUES (?, ?, 1, ?)'
      ).run(serverId, pattern, now);
      created++;
    }
  }

  return { ok: true, created };
};
