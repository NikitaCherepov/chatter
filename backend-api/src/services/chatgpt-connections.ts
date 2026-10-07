import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db.js';
import { getEncryptionKey } from '../utils/encryption.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
type Credentials = { client_id: string; access_token: string; refresh_token: string; id_token: string; scopes: string[]; expires_at: number };
type Connection = { id: number; name: string; subject: string; email: string; credentials: string; updated_at: number; shared: number };
type Attempt = { userId: number; nonce: string; verifier: string; redirectUri: string; connectionId?: number; clientId: string; expiresAt: number };
const attempts = new Map<string, Attempt>();
const refreshes = new Map<number, Promise<Credentials>>();
db.exec(`CREATE TABLE IF NOT EXISTS chatgpt_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL,
  credentials TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`);
if (!(db.prepare('PRAGMA table_info(chatgpt_connections)').all() as { name: string }[]).some(column => column.name === 'shared')) db.exec('ALTER TABLE chatgpt_connections ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0, 1))');
const actor = new AsyncLocalStorage<boolean>();
export const withChatGptActor = <T>(isAdmin: boolean, action: () => T): T => actor.run(isAdmin, action);
export const assertChatGptAccess = (id: number) => { if (!row(id).shared && actor.getStore() !== true) throw new Error('chatgpt_admin_only'); };
export const getChatGptConnection = (id: number) => { const value = row(id); return { id: value.id, shared: value.shared === 1 }; };
const encrypt = (value: Credentials) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  return [iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()].map(value => value.toString('base64url')).join('.');
};
const decrypt = (value: string): Credentials => {
  const [iv, data, tail, tag] = value.split('.').map(value => Buffer.from(value, 'base64url'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.update(tail), cipher.final()]).toString());
};
const row = (id: number) => {
  const result = db.prepare('SELECT * FROM chatgpt_connections WHERE id = ?').get(id) as Connection | undefined;
  if (!result) throw new Error('chatgpt_connection_not_found');
  return result;
};
export const listChatGptConnections = () => (db.prepare('SELECT * FROM chatgpt_connections ORDER BY id').all() as Connection[]).map(value => {
  const credentials = decrypt(value.credentials);
  return { id: value.id, name: value.name, email: value.email, shared: value.shared === 1, expiresAt: credentials.expires_at, planUsageEnabled: credentials.scopes.includes('chatgpt.tokens.use.direct') };
});
export const validateChatGptRedirect = (redirectUri: string) => {
  const url = new URL(redirectUri);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/auth/callback' || url.search || url.hash || url.username || url.password) throw new Error('bad_chatgpt_callback');
  return url.toString();
};
let metadata: any;
const discovery = async () => {
  if (!metadata) {
    const result = await fetch(ISSUER + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(15_000) });
    if (!result.ok) throw new Error('chatgpt_discovery_failed');
    const value = await result.json() as any;
    if (value.issuer !== ISSUER || new URL(value.jwks_uri).origin !== ISSUER || new URL(value.revocation_endpoint).origin !== ISSUER) throw new Error('chatgpt_bad_discovery');
    metadata = value;
  }
  return metadata;
};
export async function verifyChatGptIdentity(token: string, clientId: string, nonce?: string, expectedSubject?: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('chatgpt_invalid_identity');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('chatgpt_invalid_identity');
  const config = await discovery();
  const response = await fetch(config.jwks_uri, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('chatgpt_identity_keys_unavailable');
  const jwks = await response.json() as any;
  const key = jwks.keys?.find((value: any) => value.kid === header.kid && value.kty === 'RSA' && (!value.use || value.use === 'sig'));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!key || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))
    || claims.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId)
    || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() || (claims.nbf && claims.nbf * 1000 > Date.now())
    || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)
    || (expectedSubject !== undefined && claims.sub !== expectedSubject)) throw new Error('chatgpt_invalid_identity');
  return { subject: claims.sub as string, email: typeof claims.email === 'string' ? claims.email : '' };
}
async function tokenRequest(body: Record<string, string>) {
  const response = await fetch(ISSUER + '/api/accounts/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'chatgpt_reauthorization_required' : 'chatgpt_token_request_failed');
  return await response.json() as any;
}
const parseTokens = (value: any, clientId: string, previous?: Credentials): Credentials => {
  const scopes = typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  const expires = Number(value.expires_in);
  if (typeof value.access_token !== 'string' || !value.access_token || !Number.isFinite(expires) || expires <= 0 || !scopes
    || !scopes.includes('chatgpt.tokens.use.direct') || (value.token_type && value.token_type.toLowerCase() !== 'bearer')) throw new Error('chatgpt_plan_usage_not_enabled');
  const refresh = value.refresh_token ?? previous?.refresh_token;
  const idToken = value.id_token ?? previous?.id_token;
  if (typeof refresh !== 'string' || !refresh || typeof idToken !== 'string' || !idToken) throw new Error('chatgpt_incomplete_credentials');
  return { client_id: clientId, access_token: value.access_token, refresh_token: refresh, id_token: idToken, scopes, expires_at: Date.now() + expires * 1000 };
};
export const beginChatGptAuthorization = (userId: number, redirectUri: string, connectionId?: number) => {
  for (const [state, attempt] of attempts) if (attempt.expiresAt <= Date.now() || attempt.userId === userId) attempts.delete(state);
  if (attempts.size >= 50) throw new Error('chatgpt_too_many_sign_in_attempts');
  const saved = connectionId ? decrypt(row(connectionId).credentials) : null;
  let host = db.prepare("SELECT value_json FROM system_settings WHERE key = 'chatgpt_host_id'").get() as { value_json: string } | undefined;
  if (!host) {
    const value = JSON.stringify('urn:uuid:' + crypto.randomUUID());
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES ('chatgpt_host_id', ?, ?)").run(value, Date.now());
    host = { value_json: value };
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const callback = validateChatGptRedirect(redirectUri);
  const clientId = saved?.client_id || 'dynamic_agent_client';
  attempts.set(state, { userId, nonce, verifier, redirectUri: callback, connectionId, clientId, expiresAt: Date.now() + 5 * 60_000 });
  const params = new URLSearchParams({ client_id: clientId, ext_agent_host_id: JSON.parse(host.value_json), response_type: 'code',
    redirect_uri: callback, scope: SCOPE, resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
  if (saved) params.set('id_token_hint', saved.id_token); else params.set('agent_name_hint', 'Chatter');
  return { state, authorizeUrl: ISSUER + '/api/accounts/authorize?' + params };
};
export async function completeChatGptAuthorization(userId: number, input: { state: string; code: string; clientId?: string; error?: string }) {
  const attempt = attempts.get(input.state);
  if (!attempt || attempt.userId !== userId || attempt.expiresAt <= Date.now()) throw new Error('chatgpt_invalid_authorization_state');
  attempts.delete(input.state);
  if (input.error) throw new Error('chatgpt_authorization_declined');
  const clientId = attempt.clientId === 'dynamic_agent_client' ? input.clientId : attempt.clientId;
  if (typeof clientId !== 'string' || !clientId || clientId === 'dynamic_agent_client' || clientId.length > 512 || /[\s\0]/.test(clientId) || (attempt.clientId !== 'dynamic_agent_client' && input.clientId && input.clientId !== clientId)
    || typeof input.code !== 'string' || !input.code || input.code.length > 16_384) throw new Error('chatgpt_incomplete_registration');
  const value = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: input.code,
    code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
  const previous = attempt.connectionId ? row(attempt.connectionId) : null;
  const identity = await verifyChatGptIdentity(value.id_token, clientId, attempt.nonce, previous?.subject);
  const credentials = parseTokens(value, clientId);
  const now = Date.now();
  let id = attempt.connectionId;
  if (id) db.prepare('UPDATE chatgpt_connections SET email = ?, credentials = ?, updated_at = ? WHERE id = ?').run(identity.email, encrypt(credentials), now, id);
  else {
    const duplicate = (db.prepare('SELECT * FROM chatgpt_connections WHERE subject = ?').all(identity.subject) as Connection[]).find(value => decrypt(value.credentials).client_id === clientId);
    if (duplicate) throw new Error('chatgpt_connection_already_exists');
    id = Number(db.prepare('INSERT INTO chatgpt_connections (name, subject, email, credentials, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(identity.email || 'ChatGPT', identity.subject, identity.email, encrypt(credentials), now, now).lastInsertRowid);
  }
  return listChatGptConnections().find(value => value.id === id)!;
}
export async function getChatGptAccessToken(id: number): Promise<string> {
  const current = decrypt(row(id).credentials);
  if (current.expires_at > Date.now() + 60_000) return current.access_token;
  let pending = refreshes.get(id);
  if (!pending) {
    pending = (async () => {
      const connection = row(id);
      const previous = decrypt(connection.credentials);
      const value = await tokenRequest({ grant_type: 'refresh_token', client_id: previous.client_id, refresh_token: previous.refresh_token, resource: RESOURCE });
      if (value.id_token) await verifyChatGptIdentity(value.id_token, previous.client_id, undefined, connection.subject);
      const next = parseTokens(value, previous.client_id, previous);
      // A disconnect/reconnect during refresh must not resurrect or overwrite the session.
      const changed = db.prepare('UPDATE chatgpt_connections SET credentials = ?, updated_at = ? WHERE id = ? AND credentials = ?')
        .run(encrypt(next), Date.now(), id, connection.credentials);
      if (!changed.changes) throw new Error('chatgpt_connection_changed');
      return next;
    })();
    refreshes.set(id, pending);
  }
  try { return (await pending).access_token; }
  finally { if (refreshes.get(id) === pending) refreshes.delete(id); }
}
export const renameChatGptConnection = (id: number, name: string, shared?: boolean) => {
  row(id);
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('chatgpt_bad_connection_name');
  if (shared !== undefined && typeof shared !== 'boolean') throw new Error('chatgpt_bad_access');
  db.prepare('UPDATE chatgpt_connections SET name = ?, shared = ?, updated_at = ? WHERE id = ?').run(name.trim(), shared === undefined ? row(id).shared : shared ? 1 : 0, Date.now(), id);
  return listChatGptConnections();
};
export async function disconnectChatGptConnection(id: number) {
  const saved = decrypt(row(id).credentials);
  const config = await discovery();
  const response = await fetch(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: saved.refresh_token, token_type_hint: 'refresh_token', client_id: saved.client_id }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('chatgpt_revocation_failed');
  db.prepare('DELETE FROM chatgpt_connections WHERE id = ?').run(id);
  return { ok: true };
}
export async function listChatGptModels(id: number) {
  const token = await getChatGptAccessToken(id);
  const response = await fetch(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(response.status === 401 ? 'chatgpt_reauthorization_required' : 'chatgpt_models_unavailable');
  const json = await response.json() as any;
  if (!Array.isArray(json.models)) throw new Error('chatgpt_invalid_models_response');
  return json.models.filter((model: any) => model.visibility === 'list' && typeof model.slug === 'string')
    .map((model: any) => ({ slug: model.slug, name: typeof model.display_name === 'string' ? model.display_name : model.slug }));
}
