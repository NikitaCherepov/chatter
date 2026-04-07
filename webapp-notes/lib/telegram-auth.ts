import crypto from 'node:crypto';

export type TelegramAuthContext = {
  userId: number;
};

const SAFE_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;

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

export const verifyAndExtractTelegramUser = (initData: string): TelegramAuthContext | null => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  if (!hash) return null;

  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : 0;
  if (!Number.isFinite(authDate) || authDate <= 0) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - authDate) > SAFE_AUTH_MAX_AGE_SECONDS) return null;

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const checkString = toDataCheckString(initData);
  const computedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  const left = Buffer.from(computedHash, 'hex');
  const right = Buffer.from(hash, 'hex');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw) as { id?: number };
    if (!Number.isFinite(user.id) || !user.id || user.id <= 0) return null;
    return { userId: Math.floor(user.id) };
  } catch {
    return null;
  }
};
