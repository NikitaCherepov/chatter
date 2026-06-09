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
  default_ssh_key_id: number | null;
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
  default_ssh_key_id: number | null;
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
    default_ssh_key_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_devops_servers_user ON devops_servers(user_id)');

// Safe migration for existing tables
try { db.exec('ALTER TABLE devops_servers ADD COLUMN sudo_password_enc TEXT'); } catch {}
try { db.exec('ALTER TABLE devops_servers ADD COLUMN default_ssh_key_id INTEGER'); } catch {}

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
  default_ssh_key_id: row.default_ssh_key_id,
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

  // Resolve private key: own field > default ssh key pair
  let privateKey: string | undefined = row.private_key_enc ? decrypt(row.private_key_enc) : undefined;
  if (!privateKey && row.default_ssh_key_id) {
    const keyRow = db.prepare('SELECT private_key_enc FROM devops_ssh_keys WHERE user_id = ? AND id = ? AND private_key_enc IS NOT NULL')
      .get(userId, row.default_ssh_key_id) as { private_key_enc: string } | undefined;
    if (keyRow) privateKey = decrypt(keyRow.private_key_enc);
  }

  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password_enc ? decrypt(row.password_enc) : undefined,
    privateKey,
    sudoPassword: row.sudo_password_enc ? decrypt(row.sudo_password_enc) : undefined,
  };
};

/** Safe check — does the server have a stored sudo password? (no decryption) */
export const serverHasSudoPassword = (userId: number, serverId: number): boolean => {
  const row = db.prepare(
    'SELECT sudo_password_enc FROM devops_servers WHERE user_id = ? AND id = ?'
  ).get(userId, serverId) as { sudo_password_enc: string | null } | undefined;
  return !!row?.sudo_password_enc;
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
  defaultSshKeyId?: number | null,
): { ok: true; id: number } | { ok: false; error: string } => {
  // Validation
  const trimmedName = name.trim();
  const trimmedHost = host.trim();
  const trimmedUsername = username.trim();

  if (!trimmedName) return { ok: false, error: 'name_required' };
  if (!trimmedHost) return { ok: false, error: 'host_required' };
  if (!trimmedUsername) return { ok: false, error: 'username_required' };
  if (!port || port < 1 || port > 65535) return { ok: false, error: 'invalid_port' };
  if (!password && !privateKey && !defaultSshKeyId) return { ok: false, error: 'auth_required' };

  // Validate defaultSshKeyId if provided
  if (defaultSshKeyId) {
    const keyRow = db.prepare('SELECT id FROM devops_ssh_keys WHERE user_id = ? AND id = ?')
      .get(userId, defaultSshKeyId);
    if (!keyRow) return { ok: false, error: 'invalid_ssh_key' };
  }

  // Limit check
  const count = db.prepare('SELECT COUNT(*) as cnt FROM devops_servers WHERE user_id = ?')
    .get(userId) as { cnt: number };
  if (count.cnt >= SERVERS_PER_USER) return { ok: false, error: 'servers_limit' };

  const now = getNowUnix();
  const passwordEnc = password ? encrypt(password) : null;
  const privateKeyEnc = privateKey ? encrypt(privateKey) : null;
  const sudoPasswordEnc = sudoPassword ? encrypt(sudoPassword) : null;

  const result = db.prepare(`
    INSERT INTO devops_servers (user_id, name, host, port, username, password_enc, private_key_enc, sudo_password_enc, default_ssh_key_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, trimmedName, trimmedHost, port, trimmedUsername, passwordEnc, privateKeyEnc, sudoPasswordEnc, defaultSshKeyId ?? null, now, now);

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
    defaultSshKeyId?: number | null;
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
  if (updates.defaultSshKeyId !== undefined) {
    setClauses.push('default_ssh_key_id = ?');
    values.push(updates.defaultSshKeyId ?? null);
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

// ── SSH Keys (key pairs for deploying to servers) ──────────────────────────

export type DevopsSshKey = {
  id: number;
  user_id: number;
  name: string;
  public_key: string;
  has_private_key: boolean;
  created_at: number;
  updated_at: number;
};

type DevopsSshKeyRow = {
  id: number;
  user_id: number;
  name: string;
  public_key_enc: string;
  private_key_enc: string | null;
  created_at: number;
  updated_at: number;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS devops_ssh_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    public_key_enc TEXT NOT NULL,
    private_key_enc TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_devops_ssh_keys_user ON devops_ssh_keys(user_id)');

// Safe migration
try { db.exec('ALTER TABLE devops_ssh_keys ADD COLUMN private_key_enc TEXT'); } catch {}

const SSH_KEYS_LIMIT = 20;

const sshKeyRowToDto = (row: DevopsSshKeyRow): DevopsSshKey => ({
  id: row.id,
  user_id: row.user_id,
  name: row.name,
  public_key: decrypt(row.public_key_enc),
  has_private_key: !!row.private_key_enc,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const listSshKeys = (userId: number): DevopsSshKey[] => {
  const rows = db.prepare('SELECT * FROM devops_ssh_keys WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as DevopsSshKeyRow[];
  return rows.map(sshKeyRowToDto);
};

export const getSshKeyById = (userId: number, keyId: number): DevopsSshKey | null => {
  const row = db.prepare('SELECT * FROM devops_ssh_keys WHERE user_id = ? AND id = ?')
    .get(userId, keyId) as DevopsSshKeyRow | undefined;
  return row ? sshKeyRowToDto(row) : null;
};

/** Returns decrypted public key — used only when deploying to a server */
export const getSshPublicKey = (userId: number, keyId: number): string | null => {
  const row = db.prepare('SELECT public_key_enc FROM devops_ssh_keys WHERE user_id = ? AND id = ?')
    .get(userId, keyId) as { public_key_enc: string } | undefined;
  return row ? decrypt(row.public_key_enc) : null;
};

export const createSshKey = (
  userId: number,
  name: string,
  publicKey: string,
  privateKey?: string,
): { ok: true; id: number } | { ok: false; error: string } => {
  const trimmedName = name.trim();
  const trimmedKey = publicKey.trim();

  if (!trimmedName) return { ok: false, error: 'name_required' };
  if (!trimmedKey) return { ok: false, error: 'public_key_required' };

  // Basic validation: public key should start with ssh- or ecjsa-
  if (!trimmedKey.startsWith('ssh-') && !trimmedKey.startsWith('ecdsa-')) {
    return { ok: false, error: 'invalid_public_key_format' };
  }

  const count = db.prepare('SELECT COUNT(*) as cnt FROM devops_ssh_keys WHERE user_id = ?')
    .get(userId) as { cnt: number };
  if (count.cnt >= SSH_KEYS_LIMIT) return { ok: false, error: 'ssh_keys_limit' };

  const now = getNowUnix();
  const privateKeyEnc = privateKey ? encrypt(privateKey) : null;
  const result = db.prepare(
    'INSERT INTO devops_ssh_keys (user_id, name, public_key_enc, private_key_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, trimmedName, encrypt(trimmedKey), privateKeyEnc, now, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const updateSshKey = (
  userId: number,
  keyId: number,
  updates: { name?: string; public_key?: string },
): { ok: true } | { ok: false; error: string } => {
  const existing = db.prepare('SELECT * FROM devops_ssh_keys WHERE user_id = ? AND id = ?')
    .get(userId, keyId) as DevopsSshKeyRow | undefined;
  if (!existing) return { ok: false, error: 'not_found' };

  const now = getNowUnix();
  const name = updates.name !== undefined ? updates.name.trim() : existing.name;
  const publicKey = updates.public_key !== undefined ? updates.public_key.trim() : decrypt(existing.public_key_enc);

  if (!name) return { ok: false, error: 'name_required' };
  if (!publicKey) return { ok: false, error: 'public_key_required' };

  db.prepare('UPDATE devops_ssh_keys SET name = ?, public_key_enc = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(name, encrypt(publicKey), now, keyId, userId);

  return { ok: true };
};

export const deleteSshKey = (userId: number, keyId: number): boolean => {
  // Reset default_ssh_key_id on all servers that reference this key
  db.prepare('UPDATE devops_servers SET default_ssh_key_id = NULL WHERE user_id = ? AND default_ssh_key_id = ?')
    .run(userId, keyId);

  return db.prepare('DELETE FROM devops_ssh_keys WHERE user_id = ? AND id = ?')
    .run(userId, keyId).changes > 0;
};

/**
 * Build the shell script to install a public SSH key for a target user.
 * Handles both root and non-root users with proper permissions.
 */
export const buildInstallKeyScript = (targetUser: string, publicKey: string): string => {
  const escapedKey = publicKey.replace(/'/g, "'\\''");
  if (targetUser === 'root') {
    return [
      `mkdir -p /root/.ssh`,
      `printf '%s\\n' '${escapedKey}' >> /root/.ssh/authorized_keys`,
      `sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys`,
      `chmod 700 /root/.ssh`,
      `chmod 600 /root/.ssh/authorized_keys`,
      `chown -R root:root /root/.ssh`,
    ].join(' && ');
  }
  return [
    `mkdir -p /home/${targetUser}/.ssh`,
    `printf '%s\\n' '${escapedKey}' >> /home/${targetUser}/.ssh/authorized_keys`,
    `sort -u /home/${targetUser}/.ssh/authorized_keys -o /home/${targetUser}/.ssh/authorized_keys`,
    `chmod 700 /home/${targetUser}/.ssh`,
    `chmod 600 /home/${targetUser}/.ssh/authorized_keys`,
    `chown -R ${targetUser}:${targetUser} /home/${targetUser}/.ssh`,
  ].join(' && ');
};
