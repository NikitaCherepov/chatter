import crypto from 'node:crypto';
import { db } from '../db.js';

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export const isServerAccessKeyGateEnabled = () => {
  const row = db.prepare('SELECT enabled FROM server_access_key_state WHERE id = 1').get() as { enabled: number } | undefined;
  return row?.enabled === 1;
};

export const isServerAccessKeyActive = (keyId: number) => Boolean(db.prepare(
  'SELECT 1 FROM server_access_keys WHERE id = ? AND revoked_at IS NULL'
).get(keyId));

export const validateServerAccessKey = (rawKey: string) => {
  const key = `${rawKey || ''}`.trim();
  if (!key) return null;
  const row = db.prepare('SELECT id, name, key_prefix FROM server_access_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .get(hashKey(key)) as { id: number; name: string; key_prefix: string } | undefined;
  if (!row) return null;
  db.prepare('UPDATE server_access_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return row;
};

export const createServerAccessKey = (nameRaw: string) => {
  const name = `${nameRaw || ''}`.trim().slice(0, 100) || 'Ключ доступа';
  const key = `chatter_sk_${crypto.randomBytes(32).toString('base64url')}`;
  const keyPrefix = `${key.slice(0, 18)}…`;
  const result = db.transaction(() => {
    db.prepare('UPDATE server_access_key_state SET enabled = 1 WHERE id = 1').run();
    return db.prepare('INSERT INTO server_access_keys (name, key_hash, key_prefix) VALUES (?, ?, ?)')
      .run(name, hashKey(key), keyPrefix);
  })();
  return { id: Number(result.lastInsertRowid), name, key, key_prefix: keyPrefix };
};

export const associateServerAccessKeyUser = (keyId: number, userId: number) => db.prepare(`
  INSERT INTO server_access_key_users (key_id, user_id) VALUES (?, ?)
  ON CONFLICT(key_id, user_id) DO UPDATE SET last_used_at = CURRENT_TIMESTAMP
`).run(keyId, userId);

export const revokeServerAccessKey = (keyId: number) => db.prepare(
  'UPDATE server_access_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?'
).run(keyId);

export const listServerAccessKeys = () => db.prepare(`
  SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
    COUNT(ku.user_id) AS user_count,
    COALESCE(SUM(u.total_tokens_used), 0) AS total_tokens_used,
    COALESCE(SUM(u.daily_tokens_used), 0) AS daily_tokens_used
  FROM server_access_keys k
  LEFT JOIN server_access_key_users ku ON ku.key_id = k.id
  LEFT JOIN users u ON u.id = ku.user_id
  GROUP BY k.id ORDER BY k.id DESC
`).all();

export const getLastServerAccessKeyForUser = (userId: number) => db.prepare(`
  SELECT k.id, k.name, k.key_prefix, ku.last_used_at, k.revoked_at
  FROM server_access_key_users ku JOIN server_access_keys k ON k.id = ku.key_id
  WHERE ku.user_id = ? ORDER BY datetime(ku.last_used_at) DESC, k.id DESC LIMIT 1
`).get(userId) || null;
