import { db } from '../db.js';
import type { UserRecord } from '../types.js';

export type AccountIdentityProvider = 'password' | 'telegram' | string;

export type AccountIdentity = {
  id: number;
  account_id: number;
  provider: AccountIdentityProvider;
  provider_subject: string;
  username: string | null;
  password_salt: string | null;
  password_hash: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export type AuthPrincipal = {
  token_subject: number;
  account_id: number;
  auth_token_version: number;
  status: UserRecord['status'];
  is_admin: number;
};

export type UnlinkDataOwner = 'desktop' | 'telegram';

export type TelegramUnlinkResult = {
  data_owner: UnlinkDataOwner;
  data_account_id: number;
  desktop_account_id: number;
  telegram_account_id: number;
  detached_account_id: number;
  telegram_id: number;
  telegram_username: string | null;
};

const tableExists = (table: string) => Boolean(db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
  .get(table));

const tableHasColumn = (table: string, column: string) => {
  if (!tableExists(table)) return false;
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return columns.some(item => item.name === column);
};

const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

const additiveUserColumns = [
  'daily_message_count',
  'total_message_length',
  'daily_tokens_used',
  'total_tokens_used',
  'daily_cost_rub',
  'total_cost_rub',
  'daily_web_search_count',
  'total_web_search_count',
  'daily_image_gen_count',
  'total_image_gen_count',
];

export const getRawAccountById = (accountId: number) => db
  .prepare('SELECT * FROM users WHERE id = ?')
  .get(accountId) as UserRecord | undefined;

export const resolveAccountId = (accountId: number): number => {
  let current = Math.floor(Number(accountId));
  if (!Number.isFinite(current) || current <= 0) return accountId;

  const visited = new Set<number>();
  for (let depth = 0; depth < 20; depth += 1) {
    if (visited.has(current)) throw new Error('account_redirect_cycle');
    visited.add(current);
    const row = db.prepare('SELECT target_account_id FROM account_redirects WHERE source_account_id = ?')
      .get(current) as { target_account_id: number } | undefined;
    const next = Number(row?.target_account_id);
    if (!Number.isFinite(next) || next <= 0 || next === current) break;
    current = Math.floor(next);
  }
  return current;
};

export const getAuthPrincipal = (tokenSubject: number): AuthPrincipal | null => {
  const normalized = Math.floor(Number(tokenSubject));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;

  const user = getRawAccountById(normalized);
  if (user) {
    return {
      token_subject: normalized,
      account_id: resolveAccountId(normalized),
      auth_token_version: Math.max(0, Math.floor(Number(user.auth_token_version || 0))),
      status: user.status,
      is_admin: user.is_admin,
    };
  }

  const redirect = db.prepare(`
    SELECT target_account_id, source_auth_token_version, source_status, source_is_admin
    FROM account_redirects
    WHERE source_account_id = ?
  `).get(normalized) as {
    target_account_id: number;
    source_auth_token_version: number;
    source_status: UserRecord['status'];
    source_is_admin: number;
  } | undefined;
  if (!redirect) return null;

  return {
    token_subject: normalized,
    account_id: resolveAccountId(redirect.target_account_id),
    auth_token_version: Math.max(0, Math.floor(Number(redirect.source_auth_token_version || 0))),
    status: redirect.source_status,
    is_admin: Number(redirect.source_is_admin || 0),
  };
};

export const getAccountIdentity = (provider: AccountIdentityProvider, providerSubject: string) => db
  .prepare(`
    SELECT *
    FROM account_identities
    WHERE provider = ? AND provider_subject = ?
  `)
  .get(provider, providerSubject) as AccountIdentity | undefined;

export const getAccountIdentities = (accountId: number) => db
  .prepare(`
    SELECT *
    FROM account_identities
    WHERE account_id = ?
    ORDER BY id ASC
  `)
  .all(resolveAccountId(accountId)) as AccountIdentity[];

export const getPasswordIdentityByLogin = (login: string) => getAccountIdentity('password', login);

export const getTelegramIdentityForAccount = (accountId: number) => db
  .prepare(`
    SELECT *
    FROM account_identities
    WHERE account_id = ? AND provider = 'telegram'
    ORDER BY id ASC
    LIMIT 1
  `)
  .get(resolveAccountId(accountId)) as AccountIdentity | undefined;

export const getAccountIdByTelegramId = (telegramId: number) => {
  const identity = getAccountIdentity('telegram', String(Math.floor(telegramId)));
  return identity ? resolveAccountId(identity.account_id) : null;
};

export const resolveExternalAccountId = (
  provider: AccountIdentityProvider,
  providerSubject: string | number,
) => {
  const identity = getAccountIdentity(provider, String(providerSubject));
  return identity ? resolveAccountId(identity.account_id) : null;
};

export const isAccountIdReserved = (accountId: number) => {
  const normalized = Math.floor(Number(accountId));
  if (!Number.isFinite(normalized) || normalized <= 0) return true;
  if (getRawAccountById(normalized)) return true;
  return Boolean(db.prepare('SELECT 1 FROM account_redirects WHERE source_account_id = ?').get(normalized));
};

export const allocateAccountId = () => {
  const row = db.prepare(`
    SELECT COALESCE(MAX(account_id), 0) AS max_id
    FROM (
      SELECT id AS account_id FROM users
      UNION ALL SELECT source_account_id FROM account_redirects
      UNION ALL SELECT target_account_id FROM account_redirects
      UNION ALL SELECT account_id FROM account_identities
    )
  `).get() as { max_id: number };
  return Math.max(1, Math.floor(Number(row?.max_id || 0)) + 1);
};

export const createPasswordIdentity = (
  accountId: number,
  login: string,
  passwordSalt: string,
  passwordHash: string,
) => db.prepare(`
  INSERT INTO account_identities (
    account_id, provider, provider_subject, username, password_salt, password_hash
  )
  VALUES (?, 'password', ?, ?, ?, ?)
`).run(resolveAccountId(accountId), login, login, passwordSalt, passwordHash);

export const ensureTelegramIdentity = (
  accountId: number,
  telegramId: number,
  username: string | null,
) => db.transaction(() => {
  const canonicalAccountId = resolveAccountId(accountId);
  const providerSubject = String(Math.floor(telegramId));
  const existing = getAccountIdentity('telegram', providerSubject);
  if (existing) {
    if (resolveAccountId(existing.account_id) !== canonicalAccountId) {
      throw new Error('telegram_identity_already_linked');
    }
    return db.prepare(`
      UPDATE account_identities
      SET username = COALESCE(?, username), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(username, existing.id);
  }
  return db.prepare(`
    INSERT INTO account_identities (account_id, provider, provider_subject, username)
    VALUES (?, 'telegram', ?, ?)
  `).run(canonicalAccountId, providerSubject, username);
})();

export const resolveTelegramAccountForUpsert = (telegramId: number) => {
  const existing = getAccountIdByTelegramId(telegramId);
  if (existing) return existing;
  return allocateAccountId();
};

const moveSimpleOwnership = (sourceAccountId: number, targetAccountId: number) => {
  const tables = [
    'chat_messages',
    'user_chats',
    'notes',
    'tasks',
    'macros',
    'user_prompts',
    'map_pins',
    'devops_servers',
    'devops_runbooks',
    'devops_ssh_keys',
    'pc_commands_policies',
    'telegram_link_codes',
  ];

  for (const table of tables) {
    if (!tableHasColumn(table, 'user_id')) continue;
    db.prepare(`UPDATE ${quoteIdentifier(table)} SET user_id = ? WHERE user_id = ?`)
      .run(targetAccountId, sourceAccountId);
  }

  if (tableHasColumn('user_plan_subscriptions', 'user_id')) {
    if (tableHasColumn('user_plan_subscriptions', 'is_current')) {
      db.prepare('UPDATE user_plan_subscriptions SET is_current = 0 WHERE user_id = ?')
        .run(sourceAccountId);
    }
    db.prepare('UPDATE user_plan_subscriptions SET user_id = ? WHERE user_id = ?')
      .run(targetAccountId, sourceAccountId);
  }
};

const moveRowsWithSourcePriority = (
  table: string,
  keyColumns: string[],
  sourceAccountId: number,
  targetAccountId: number,
) => {
  if (!tableHasColumn(table, 'user_id') || keyColumns.some(column => !tableHasColumn(table, column))) return;
  const matches = keyColumns
    .map(column => `target.${quoteIdentifier(column)} = source.${quoteIdentifier(column)}`)
    .join(' AND ');
  db.prepare(`
    DELETE FROM ${quoteIdentifier(table)} AS target
    WHERE target.user_id = ?
      AND EXISTS (
        SELECT 1
        FROM ${quoteIdentifier(table)} AS source
        WHERE source.user_id = ? AND ${matches}
      )
  `).run(targetAccountId, sourceAccountId);
  db.prepare(`UPDATE ${quoteIdentifier(table)} SET user_id = ? WHERE user_id = ?`)
    .run(targetAccountId, sourceAccountId);
};

const moveSingletonWithSourcePriority = (
  table: string,
  sourceAccountId: number,
  targetAccountId: number,
) => {
  if (!tableHasColumn(table, 'user_id')) return;
  const sourceExists = Boolean(db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE user_id = ? LIMIT 1`)
    .get(sourceAccountId));
  if (!sourceExists) return;
  db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE user_id = ?`).run(targetAccountId);
  db.prepare(`UPDATE ${quoteIdentifier(table)} SET user_id = ? WHERE user_id = ?`)
    .run(targetAccountId, sourceAccountId);
};

const moveSingletonWithTargetPriority = (
  table: string,
  sourceAccountId: number,
  targetAccountId: number,
) => {
  if (!tableHasColumn(table, 'user_id')) return;
  const targetExists = Boolean(db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE user_id = ? LIMIT 1`)
    .get(targetAccountId));
  if (targetExists) db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE user_id = ?`).run(sourceAccountId);
  else db.prepare(`UPDATE ${quoteIdentifier(table)} SET user_id = ? WHERE user_id = ?`)
    .run(targetAccountId, sourceAccountId);
};

const mergeUserScalarData = (
  sourceAccountId: number,
  targetAccountId: number,
) => {
  const source = getRawAccountById(sourceAccountId) as Record<string, unknown> | undefined;
  const target = getRawAccountById(targetAccountId) as Record<string, unknown> | undefined;
  if (!source || !target) throw new Error('account_merge_user_not_found');

  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const available = new Set(columns.map(column => column.name));
  const updates: Record<string, unknown> = {};

  for (const column of additiveUserColumns) {
    if (!available.has(column)) continue;
    updates[column] = Number(target[column] || 0) + Number(source[column] || 0);
  }

  // The desktop account is the source during linking. Its explicit personal
  // settings win, while Telegram identity/status remain on the target account.
  const sourcePreferredColumns = [
    'name',
    'selected_prompt_id',
    'custom_prompt_content',
    'core_memory',
    'active_chat_id',
    'timezone_offset',
    'timezone_confirmed',
    'context_window',
    'context_window_max',
    'imap_provider',
    'imap_user',
    'imap_pass',
    'imap_host',
    'imap_port',
    'imap_secure',
    'mail_check_limit',
    'preferred_model',
    'feature_flags',
    'reasoning_level',
    'model_settings',
    'ui_settings',
    'language',
    'subagent_mode',
    'subagent_reasoning_level',
    'max_context_tokens',
    'attachment_max_tokens',
  ];
  for (const column of sourcePreferredColumns) {
    if (!available.has(column)) continue;
    if (source[column] !== null && source[column] !== undefined && source[column] !== '') {
      updates[column] = source[column];
    }
  }

  if (available.has('is_admin')) {
    updates.is_admin = Math.max(Number(target.is_admin || 0), Number(source.is_admin || 0));
  }
  if (available.has('role') && (target.role === 'admin' || source.role === 'admin')) {
    updates.role = 'admin';
  }
  const entries = Object.entries(updates);
  if (entries.length === 0) return;
  const setSql = entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${setSql} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), targetAccountId);
};

const moveIdentities = (sourceAccountId: number, targetAccountId: number) => {
  db.prepare(`
    UPDATE account_identities
    SET account_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
  `).run(targetAccountId, sourceAccountId);
};

const moveSecondaryOwnership = (sourceAccountId: number, targetAccountId: number) => {
  if (tableHasColumn('devops_runbooks_public', 'author_user_id')) {
    db.prepare('UPDATE devops_runbooks_public SET author_user_id = ? WHERE author_user_id = ?')
      .run(targetAccountId, sourceAccountId);
  }
  if (tableHasColumn('user_plan_subscriptions', 'assigned_by')) {
    db.prepare('UPDATE user_plan_subscriptions SET assigned_by = ? WHERE assigned_by = ?')
      .run(targetAccountId, sourceAccountId);
  }
  if (tableHasColumn('bans', 'banned_by')) {
    db.prepare('UPDATE bans SET banned_by = ? WHERE banned_by = ?')
      .run(targetAccountId, sourceAccountId);
  }
};

const rebuildMessageSearchIndex = () => {
  if (!tableExists('messages_fts')) return;
  db.exec('DELETE FROM messages_fts');
  db.exec(`
    INSERT INTO messages_fts(content, user_id, chat_id, message_id)
    SELECT content, user_id, chat_id, id
    FROM chat_messages
    WHERE content IS NOT NULL AND content != ''
  `);
};

const createAccountRedirect = (
  source: UserRecord,
  targetAccountId: number,
  reason: string,
) => {
  db.prepare(`
    INSERT INTO account_redirects (
      source_account_id, target_account_id, source_auth_token_version,
      source_status, source_is_admin, reason
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_account_id) DO UPDATE SET
      target_account_id = excluded.target_account_id,
      source_auth_token_version = excluded.source_auth_token_version,
      source_status = excluded.source_status,
      source_is_admin = excluded.source_is_admin,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    source.id,
    targetAccountId,
    Math.max(0, Math.floor(Number(source.auth_token_version || 0))),
    source.status,
    source.is_admin,
    reason,
  );

  db.prepare(`
    UPDATE account_redirects
    SET target_account_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE target_account_id = ? AND source_account_id <> ?
  `).run(targetAccountId, source.id, source.id);
};

const queueNamespaceMigration = (sourceAccountId: number, targetAccountId: number) => {
  if (sourceAccountId === targetAccountId) return;
  db.prepare(`
    UPDATE account_namespace_migrations
    SET target_account_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE target_account_id = ? AND status <> 'completed'
  `).run(targetAccountId, sourceAccountId);
  db.prepare(`
    INSERT INTO account_namespace_migrations (source_account_id, target_account_id, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(source_account_id) DO UPDATE SET
      target_account_id = excluded.target_account_id,
      status = CASE
        WHEN account_namespace_migrations.status = 'completed' THEN 'completed'
        ELSE 'pending'
      END,
      updated_at = CURRENT_TIMESTAMP
  `).run(sourceAccountId, targetAccountId);
};

export const mergeAccounts = (
  sourceAccountIdRaw: number,
  targetAccountIdRaw: number,
  reason = 'manual',
) => db.transaction(() => {
  const sourceAccountId = Math.floor(Number(sourceAccountIdRaw));
  const targetAccountId = resolveAccountId(targetAccountIdRaw);
  if (resolveAccountId(sourceAccountId) === targetAccountId) return targetAccountId;

  const source = getRawAccountById(sourceAccountId);
  const target = getRawAccountById(targetAccountId);
  if (!source || !target) throw new Error('account_merge_user_not_found');

  mergeUserScalarData(sourceAccountId, targetAccountId);
  moveSimpleOwnership(sourceAccountId, targetAccountId);
  moveRowsWithSourcePriority('mail_accounts', ['provider'], sourceAccountId, targetAccountId);
  moveRowsWithSourcePriority('smart_home_settings', ['provider'], sourceAccountId, targetAccountId);
  moveRowsWithSourcePriority('smart_devices', ['id'], sourceAccountId, targetAccountId);
  moveSingletonWithSourcePriority('pc_commands_settings', sourceAccountId, targetAccountId);
  moveSingletonWithTargetPriority('bans', sourceAccountId, targetAccountId);

  moveSecondaryOwnership(sourceAccountId, targetAccountId);
  moveIdentities(sourceAccountId, targetAccountId);
  createAccountRedirect(source, targetAccountId, reason);
  queueNamespaceMigration(sourceAccountId, targetAccountId);
  db.prepare('DELETE FROM users WHERE id = ?').run(sourceAccountId);

  rebuildMessageSearchIndex();
  return targetAccountId;
})();

export const linkAccountToTelegram = (
  sourceAccountId: number,
  telegramId: number,
  username: string | null,
) => {
  const targetAccountId = getAccountIdByTelegramId(telegramId);
  if (!targetAccountId || !getRawAccountById(targetAccountId)) {
    throw new Error('telegram_user_not_found');
  }
  const existingTelegramIdentity = getTelegramIdentityForAccount(targetAccountId);
  ensureTelegramIdentity(targetAccountId, telegramId, username || existingTelegramIdentity?.username || null);
  return mergeAccounts(sourceAccountId, targetAccountId, 'telegram_link');
};

export const unlinkTelegramFromAccount = (
  accountIdRaw: number,
  dataOwner: UnlinkDataOwner,
): TelegramUnlinkResult => db.transaction(() => {
  const dataAccountId = resolveAccountId(accountIdRaw);
  const account = getRawAccountById(dataAccountId);
  if (!account) throw new Error('account_not_found');

  const identities = getAccountIdentities(dataAccountId);
  const telegramIdentity = identities.find(identity => identity.provider === 'telegram');
  const passwordIdentities = identities.filter(identity => identity.provider === 'password');
  if (!telegramIdentity) throw new Error('telegram_not_linked');
  if (passwordIdentities.length === 0) throw new Error('password_identity_required');

  const telegramId = Math.floor(Number(telegramIdentity.provider_subject));
  if (!Number.isFinite(telegramId) || telegramId <= 0) {
    throw new Error('telegram_identity_invalid');
  }

  const detachedAccountId = allocateAccountId();
  const detachedTelegram = dataOwner === 'desktop';
  db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan, language)
    VALUES (?, ?, 'user', 0, 'approved', 'free', ?)
  `).run(
    detachedAccountId,
    account.name,
    account.language ?? null,
  );

  if (detachedTelegram) {
    db.prepare(`
      UPDATE account_identities
      SET account_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(detachedAccountId, telegramIdentity.id);
  } else {
    db.prepare(`
      UPDATE account_identities
      SET account_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE account_id = ? AND provider = 'password'
    `).run(detachedAccountId, dataAccountId);
  }

  // Revoke tokens issued before the split. Redirect-backed legacy tokens must
  // be revoked as well, otherwise they could still resolve to the data account.
  db.prepare(`
    UPDATE users
    SET auth_token_version = auth_token_version + 1
    WHERE id = ?
  `).run(dataAccountId);
  db.prepare(`
    UPDATE account_redirects
    SET source_auth_token_version = source_auth_token_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE target_account_id = ?
  `).run(dataAccountId);
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id IN (?, ?)')
    .run(dataAccountId, detachedAccountId);

  return {
    data_owner: dataOwner,
    data_account_id: dataAccountId,
    desktop_account_id: dataOwner === 'desktop' ? dataAccountId : detachedAccountId,
    telegram_account_id: dataOwner === 'telegram' ? dataAccountId : detachedAccountId,
    detached_account_id: detachedAccountId,
    telegram_id: telegramId,
    telegram_username: telegramIdentity.username,
  };
})();
