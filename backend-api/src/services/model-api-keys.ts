import crypto from 'node:crypto';
import { db } from '../db.js';
import { getAuthPrincipal } from './accounts.js';
import { getUserById } from './chats.js';
import { getModelsCatalog } from './ai.js';

type KeyRow = { id: number; owner_user_id: number; name: string; allowed_models_json: string; revoked_at: string | null };
const hash = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
export function modelApiOwner(id: number) {
  const principal = getAuthPrincipal(id);
  if (!principal || principal.status !== 'approved') return null;
  const user = getUserById(principal.account_id);
  return user && user.status === 'approved' ? user : null;
}
export function modelsForApiOwner(id: number) {
  const owner = modelApiOwner(id);
  return owner ? getModelsCatalog(owner.is_admin === 1 || owner.role === 'admin', owner.id) : [];
}
export function createModelApiKey(input: { name?: unknown; owner_user_id?: unknown; models?: unknown }) {
  const ownerId = Number(input.owner_user_id), name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !modelApiOwner(ownerId)) throw new Error('invalid_owner');
  if (!name || name.length > 100) throw new Error('invalid_name');
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 500 || input.models.some(m => typeof m !== 'string')) throw new Error('invalid_models');
  const models = [...new Set(input.models as string[])];
  const available = new Set(modelsForApiOwner(ownerId).map(m => m.id));
  if (models.some(m => !available.has(m))) throw new Error('model_not_available');
  const secret = 'chatter_api_' + crypto.randomBytes(32).toString('base64url');
  const result = db.prepare('INSERT INTO model_api_keys (owner_user_id,name,key_hash,key_prefix,allowed_models_json) VALUES (?,?,?,?,?)')
    .run(ownerId,name,hash(secret),secret.slice(0,19)+'…',JSON.stringify(models));
  return { id: Number(result.lastInsertRowid), key: secret };
}
export function validateModelApiKey(raw: unknown) {
  if (typeof raw !== 'string' || !/^chatter_api_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const key = db.prepare('SELECT id, owner_user_id, name, allowed_models_json, revoked_at FROM model_api_keys WHERE key_hash=? AND revoked_at IS NULL').get(hash(raw)) as KeyRow | undefined;
  if (!key) return null;
  const owner = modelApiOwner(key.owner_user_id);
  if (!owner) return null;
  return { ...key, owner, models: JSON.parse(key.allowed_models_json) as string[] };
}
export const isModelApiKeyActive = (id: number) => Boolean(db.prepare('SELECT 1 FROM model_api_keys WHERE id=? AND revoked_at IS NULL').get(id));
export const touchModelApiKey = (id: number) => db.prepare('UPDATE model_api_keys SET last_used_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
export const revokeModelApiKey = (id: number) => db.prepare('UPDATE model_api_keys SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE id=?').run(id);
export function listModelApiKeys() {
  const now = new Date();
  const month = Math.floor(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)/1000);
  return db.prepare(`SELECT k.id,k.owner_user_id,k.name,k.key_prefix,k.allowed_models_json,k.created_at,k.last_used_at,k.revoked_at,u.name AS owner_name,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(t.total_tokens),0) AS total_tokens,
    COALESCE(SUM(COALESCE(t.actual_cost_usd,t.estimated_cost_usd)),0) AS cost_usd,
    COALESCE(SUM(CASE WHEN r.created_at>=? THEN COALESCE(t.actual_cost_usd,t.estimated_cost_usd) ELSE 0 END),0) AS month_cost_usd,
    COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND (r.usage_received=0 OR COALESCE(t.actual_cost_usd,t.estimated_cost_usd) IS NULL) THEN 1 ELSE 0 END),0) AS unknown_cost_count
    FROM model_api_keys k LEFT JOIN users u ON u.id=k.owner_user_id
    LEFT JOIN model_api_requests r ON r.key_id=k.id LEFT JOIN user_token_usage t ON t.api_request_id=r.id
    GROUP BY k.id ORDER BY k.id DESC`).all(month).map((row: any) => {
      const { allowed_models_json, ...safe } = row;
      return { ...safe, models: JSON.parse(allowed_models_json) };
    });
}
export function beginModelApiRequest(keyId: number, modelId: string) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO model_api_requests(id,key_id,model_id,created_at) VALUES (?,?,?,?)').run(id,keyId,modelId,Math.floor(Date.now()/1000));
  return id;
}
export function finishModelApiRequest(id: string, status: string, usageReceived: boolean) {
  db.prepare('UPDATE model_api_requests SET completed_at=?,status=?,usage_received=? WHERE id=?').run(Math.floor(Date.now()/1000),status,usageReceived?1:0,id);
}
