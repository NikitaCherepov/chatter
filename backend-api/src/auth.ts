import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { getUserById } from './services/chats.js';
import { getAuthPrincipal, resolveAccountId } from './services/accounts.js';
import { isServerAccessKeyActive } from './services/server-access-keys.js';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_TOKEN || '';
const JWT_SECRET = process.env.API_JWT_SECRET || '';
if (!JWT_SECRET) throw new Error('api_jwt_secret_not_configured');
const ACCESS_TTL_SEC = Math.max(60, Number.parseInt(process.env.API_ACCESS_TTL_SEC || '3600', 10) || 3600);
const REFRESH_TTL_SEC = Math.max(300, Number.parseInt(process.env.API_REFRESH_TTL_SEC || '2592000', 10) || 2592000);

type TgAuthUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type TokenPayload = {
  sub: number;
  typ: 'access' | 'refresh';
  exp: number;
  iat: number;
  ver?: number;
  sak?: number;
};

export type AuthedRequest = Record<string, any> & { authUserId?: number };

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

const signPayload = (payload: TokenPayload) => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const content = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(content).digest('base64url');
  return `${content}.${sig}`;
};

export const verifyToken = (token: string, expectedType: 'access' | 'refresh') => {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const content = `${header}.${payload}`;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(content).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSig);
  if (signatureBuffer.length !== expectedSignatureBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) return null;

  let decoded: TokenPayload;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  if (decoded.typ !== expectedType) return null;
  if (!decoded.sub || !Number.isFinite(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000)) return null;

  const principal = getAuthPrincipal(decoded.sub);
  if (!principal || (principal.status !== 'approved' && principal.is_admin !== 1)) return null;
  const tokenVersion = Number.isFinite(Number(decoded.ver)) ? Math.floor(Number(decoded.ver)) : 0;
  const currentVersion = principal.auth_token_version;
  if (tokenVersion !== currentVersion) return null;
  if (decoded.sak && !isServerAccessKeyActive(decoded.sak)) return null;

  const canonicalAccountId = principal.account_id;
  const user = getUserById(canonicalAccountId);
  if (!user || (user.status !== 'approved' && user.is_admin !== 1)) return null;
  decoded.sub = canonicalAccountId;
  return decoded;
};

export const makePasswordHash = (plain: string) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { salt, hash };
};

export const verifyPassword = (plain: string, salt: string, hash: string) => {
  const candidate = crypto.scryptSync(plain, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
};

const parseInitData = (initData: string) => {
  if (!BOT_TOKEN) return { ok: false as const, reason: 'bot_token_missing' as const };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  const authDate = Number.parseInt(params.get('auth_date') || '0', 10);
  const userRaw = params.get('user') || '';

  const checkString = [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (!hash || calculatedHash !== hash) return { ok: false as const, reason: 'hash_mismatch' as const };
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > 60 * 60 * 24) return { ok: false as const, reason: 'expired' as const };

  let user: TgAuthUser;
  try {
    user = JSON.parse(userRaw) as TgAuthUser;
  } catch {
    return { ok: false as const, reason: 'bad_user' as const };
  }
  if (!user?.id) return { ok: false as const, reason: 'bad_user' as const };

  return { ok: true as const, user };
};

export const validateTelegramInitData = (initData: string) => parseInitData(initData);

export const issueAuthTokens = (userId: number, serverAccessKeyId?: number) => {
  userId = resolveAccountId(userId);
  const user = getUserById(userId);
  if (!user || (user.status !== 'approved' && user.is_admin !== 1)) {
    throw new Error('user_not_authorized');
  }
  const now = Math.floor(Date.now() / 1000);
  const version = Math.max(0, Math.floor(Number(user.auth_token_version || 0)));
  const serverKeyClaim = serverAccessKeyId && serverAccessKeyId > 0 ? { sak: serverAccessKeyId } : {};
  const access = signPayload({ sub: userId, typ: 'access', iat: now, exp: now + ACCESS_TTL_SEC, ver: version, ...serverKeyClaim });
  const refresh = signPayload({ sub: userId, typ: 'refresh', iat: now, exp: now + REFRESH_TTL_SEC, ver: version, ...serverKeyClaim });
  return {
    access_token: access,
    refresh_token: refresh,
    access_expires_in: ACCESS_TTL_SEC,
    refresh_expires_in: REFRESH_TTL_SEC
  };
};

export const refreshAccessToken = (refreshToken: string) => {
  const payload = verifyToken(refreshToken, 'refresh');
  if (!payload) return null;
  return issueAuthTokens(payload.sub, payload.sak);
};

export const authMiddleware = (req: AuthedRequest, res: any, next: any) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const payload = verifyToken(token, 'access');
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  req.authUserId = payload.sub;
  next();
};

export const adminMiddleware = (req: AuthedRequest, res: any, next: any) => {
  const userId = req.authUserId;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const user = getUserById(userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  if (user.is_admin === 1) return next();

  return res.status(403).json({ error: 'forbidden_admin_only' });
};
