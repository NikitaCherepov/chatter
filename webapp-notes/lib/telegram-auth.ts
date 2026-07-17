import crypto from 'node:crypto';
import { db } from './db';

export type TelegramAuthContext = {
  userId: number;
  language: string | null;
};

const DEFAULT_AUTH_MAX_AGE_SECONDS = 60 * 60;
const MIN_AUTH_MAX_AGE_SECONDS = 60;
const MAX_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;
const AUTH_FUTURE_CLOCK_SKEW_SECONDS = 60;

const getAuthMaxAgeSeconds = () => {
  const configured = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_AUTH_MAX_AGE_SECONDS;
  return Math.max(
    MIN_AUTH_MAX_AGE_SECONDS,
    Math.min(MAX_AUTH_MAX_AGE_SECONDS, Math.floor(configured))
  );
};

const toDataCheckString = (initData: string) => {
  const params = new URLSearchParams(initData);
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join('\n');
};

type TelegramIdentityContext = {
  telegramUserId: number;
  telegramLanguage: string | null;
};

export const verifyAndExtractTelegramUser = (initData: string): TelegramIdentityContext | null => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;

  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : 0;
  if (!Number.isFinite(authDate) || authDate <= 0) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSec - authDate;
  if (
    ageSeconds < -AUTH_FUTURE_CLOCK_SKEW_SECONDS
    || ageSeconds > getAuthMaxAgeSeconds()
  ) return null;

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const checkString = toDataCheckString(initData);
  const computedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  const left = Buffer.from(computedHash, 'hex');
  const right = Buffer.from(hash, 'hex');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw) as { id?: number; language_code?: string };
    if (!Number.isFinite(user.id) || !user.id || user.id <= 0) return null;
    return {
      telegramUserId: Math.floor(user.id),
      telegramLanguage: typeof user.language_code === 'string' ? user.language_code : null,
    };
  } catch {
    return null;
  }
};

export const verifyAndAuthorizeTelegramUser = (initData: string): TelegramAuthContext | null => {
  const auth = verifyAndExtractTelegramUser(initData);
  if (!auth) return null;

  let user: { id: number; language: string | null } | undefined;
  try {
    user = db.prepare(`
      SELECT users.id, users.language
      FROM account_identities
      JOIN users ON users.id = account_identities.account_id
      WHERE account_identities.provider = 'telegram'
        AND account_identities.provider_subject = ?
        AND users.status = 'approved'
      LIMIT 1
    `).get(String(auth.telegramUserId)) as { id: number; language: string | null } | undefined;
  } catch {
    // Older databases may not have account_identities yet.
  }

  user ??= db.prepare(`
    SELECT id, language
    FROM users
    WHERE id = ? AND status = 'approved'
  `).get(auth.telegramUserId) as { id: number; language: string | null } | undefined;

  return user ? {
    userId: user.id,
    language: user.language || auth.telegramLanguage,
  } : null;
};
