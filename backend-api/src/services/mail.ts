import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import { getUserById } from './chats.js';

export type MailProvider = 'yandex' | 'google';

type MailAccountRecord = {
  user_id: number;
  provider: MailProvider;
  imap_user: string;
  imap_pass: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
};

const ENCRYPTION_KEY_SOURCE = process.env.ENCRYPTION_KEY || 'dev-default-key-change-in-prod';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_SOURCE).digest();
const ENCRYPTION_IV_LENGTH = 16;
const EMAIL_PASSWORD_DELIMITER = '::';

const decryptSecret = (text: string) => {
  const parts = text.split(EMAIL_PASSWORD_DELIMITER);
  if (parts.length !== 2) throw new Error('Неверный формат секрета');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
};

const normalizeMailProvider = (providerRaw: string | null | undefined): MailProvider | null => {
  const provider = (providerRaw || '').trim().toLowerCase();
  if (['yandex', 'ya', 'яндекс'].includes(provider)) return 'yandex';
  if (['google', 'gmail', 'гугл', 'googlemail'].includes(provider)) return 'google';
  return null;
};

const getMailAccountsForUser = (userId: number) => db.prepare(`
  SELECT user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure
  FROM mail_accounts
  WHERE user_id = ?
  ORDER BY provider ASC
`).all(userId) as MailAccountRecord[];

const getMailAccountForUser = (userId: number, provider: MailProvider) => db.prepare(`
  SELECT user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure
  FROM mail_accounts
  WHERE user_id = ? AND provider = ?
`).get(userId, provider) as MailAccountRecord | undefined;

const resolveUserMailAccount = (userId: number, preferredProviderRaw?: string | null) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!user) return null;

  const preferredProvider = normalizeMailProvider(preferredProviderRaw);
  const activeProvider = normalizeMailProvider(user.imap_provider);

  if (preferredProvider) {
    const preferred = getMailAccountForUser(user.id, preferredProvider);
    if (preferred) return preferred;
  }

  if (activeProvider) {
    const active = getMailAccountForUser(user.id, activeProvider);
    if (active) return active;
  }

  const all = getMailAccountsForUser(user.id);
  if (all.length) return all[0];

  if (user.imap_user && user.imap_pass && user.imap_host) {
    const provider = normalizeMailProvider(user.imap_provider)
      || (String(user.imap_host).includes('gmail') ? 'google' : 'yandex');
    return {
      user_id: user.id,
      provider,
      imap_user: user.imap_user,
      imap_pass: user.imap_pass,
      imap_host: user.imap_host,
      imap_port: user.imap_port ?? 993,
      imap_secure: user.imap_secure ?? 1
    } as MailAccountRecord;
  }

  return null;
};

const optionalImport = async (moduleName: string) => {
  try {
    return await import(moduleName);
  } catch {
    return null;
  }
};

export const runEmailCheck = async (
  userId: number,
  searchQuery?: string,
  limit = 5,
  provider?: string,
  offset = 0,
  dateFrom?: string,
  dateTo?: string
 ) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';
  const account = resolveUserMailAccount(userId, provider);
  if (!account) return 'Ошибка: почта не настроена.';

  const imapflowMod = await optionalImport('imapflow');
  const ImapFlow = (imapflowMod as any)?.ImapFlow || (imapflowMod as any)?.default?.ImapFlow || (imapflowMod as any)?.default || null;
  if (!ImapFlow) {
    const keys = imapflowMod && typeof imapflowMod === 'object' ? Object.keys(imapflowMod).join(',') : '';
    return `Ошибка: модуль imapflow недоступен для runtime (keys: ${keys || 'none'}).`;
  }

  let decryptedPass = '';
  try {
    decryptedPass = decryptSecret(account.imap_pass);
  } catch (err: any) {
    return `Ошибка: не удалось расшифровать пароль почты (${err?.message || String(err)}).`;
  }

  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
  const userDefaultLimit = Number.isFinite(Number(user.mail_check_limit)) && Number(user.mail_check_limit) > 0
    ? Math.floor(Number(user.mail_check_limit))
    : 10;
  const desiredLimit = requestedLimit > 0 ? requestedLimit : userDefaultLimit;
  const safeLimit = user.role === 'admin'
    ? Math.max(1, desiredLimit)
    : Math.max(1, Math.min(10, desiredLimit));
  const safeOffset = Math.max(0, Math.min(500, Math.floor(offset || 0)));
  const fetchWindow = Math.min(500, safeLimit + safeOffset + 20);
  const normalizedQuery = (searchQuery || '').trim();

  const normalizeDateOnly = (value?: string) => {
    if (!value) return null;
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const y = Number.parseInt(match[1], 10);
    const m = Number.parseInt(match[2], 10);
    const d = Number.parseInt(match[3], 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  };

  const dateFromNorm = normalizeDateOnly(dateFrom || '');
  const dateToNorm = normalizeDateOnly(dateTo || '');
  const dateFromTs = dateFromNorm ? Date.parse(`${dateFromNorm}T00:00:00`) : Number.NaN;
  const dateToTs = dateToNorm ? Date.parse(`${dateToNorm}T23:59:59`) : Number.NaN;

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port || 993,
    secure: (account.imap_secure ?? 1) === 1,
    logger: false,
    auth: { user: account.imap_user, pass: decryptedPass }
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = Number(client.mailbox?.exists || 0);
      if (total <= 0) return 'Почта пуста.';

      const startSeq = Math.max(1, total - fetchWindow + 1);
      const seqRange = `${startSeq}:${total}`;

      const collected: Array<{ uid: number; from: string; subject: string; date: string; date_unix: number | null }> = [];

      for await (const msg of client.fetch(seqRange, { envelope: true })) {
        const envelope = msg.envelope;
        const fromAddress = envelope?.from?.[0]?.address || envelope?.from?.[0]?.name || 'unknown';
        const subject = envelope?.subject || '(без темы)';
        const date = envelope?.date instanceof Date ? envelope.date : null;
        const dateUnix = date ? Math.floor(date.getTime() / 1000) : null;

        if (normalizedQuery) {
          const haystack = `${fromAddress} ${subject}`.toLowerCase();
          if (!haystack.includes(normalizedQuery.toLowerCase())) continue;
        }

        if ((dateFromNorm || dateToNorm) && date) {
          const ts = date.getTime();
          if (Number.isFinite(dateFromTs) && ts < dateFromTs) continue;
          if (Number.isFinite(dateToTs) && ts > dateToTs) continue;
        }

        collected.push({
          uid: Number(msg.uid || 0),
          from: fromAddress,
          subject,
          date: date ? date.toLocaleString('ru-RU') : 'дата неизвестна',
          date_unix: dateUnix
        });
      }

      if (!collected.length) {
        if (normalizedQuery) return `Ничего не найдено по запросу "${normalizedQuery}".`;
        if (dateFromNorm || dateToNorm) return 'Писем в указанном диапазоне нет.';
        return 'Почта пуста.';
      }

      const sorted = [...collected].sort((a, b) => (b.date_unix || 0) - (a.date_unix || 0) || b.uid - a.uid);
      const sliced = sorted.slice(safeOffset, safeOffset + safeLimit);
      if (!sliced.length) return `Ничего не найдено (offset=${safeOffset}, limit=${safeLimit}).`;

      return JSON.stringify({
        provider: account.provider,
        account: account.imap_user,
        total_matches: sorted.length,
        offset: safeOffset,
        limit: safeLimit,
        items: sliced
      }, null, 2);
    } finally {
      lock.release();
    }
  } catch (err: any) {
    return `Ошибка IMAP: ${err?.message || String(err)}`;
  } finally {
    try { await client.logout(); } catch {}
  }
};

export const runEmailRead = async (userId: number, subjectPart: string, provider?: string ) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';
  const account = resolveUserMailAccount(userId, provider);
  if (!account) return 'Ошибка: почта не настроена.';

  const imapflowMod = await optionalImport('imapflow');
  const ImapFlow = (imapflowMod as any)?.ImapFlow || (imapflowMod as any)?.default?.ImapFlow || (imapflowMod as any)?.default || null;
  if (!ImapFlow) {
    const keys = imapflowMod && typeof imapflowMod === 'object' ? Object.keys(imapflowMod).join(',') : '';
    return `Ошибка: модуль imapflow недоступен для runtime (keys: ${keys || 'none'}).`;
  }

  let decryptedPass = '';
  try {
    decryptedPass = decryptSecret(account.imap_pass);
  } catch (err: any) {
    return `Ошибка: не удалось расшифровать пароль почты (${err?.message || String(err)}).`;
  }

  const normalizedSubject = (subjectPart || '').trim();
  if (!normalizedSubject) return 'Ошибка: пустой subject_part.';

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port || 993,
    secure: (account.imap_secure ?? 1) === 1,
    logger: false,
    auth: { user: account.imap_user, pass: decryptedPass }
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = Number(client.mailbox?.exists || 0);
      if (total <= 0) return 'Почта пуста.';

      const startSeq = Math.max(1, total - 200 + 1);
      const seqRange = `${startSeq}:${total}`;
      const candidates: Array<{ uid: number; dateUnix: number; subject: string }> = [];

      for await (const msg of client.fetch(seqRange, { envelope: true })) {
        const subject = msg.envelope?.subject || '';
        if (!subject.toLowerCase().includes(normalizedSubject.toLowerCase())) continue;
        const d = msg.envelope?.date instanceof Date ? msg.envelope.date.getTime() : 0;
        candidates.push({ uid: Number(msg.uid || 0), dateUnix: Math.floor(d / 1000), subject });
      }

      if (!candidates.length) return `Письмо по теме "${normalizedSubject}" не найдено.`;
      candidates.sort((a, b) => b.dateUnix - a.dateUnix || b.uid - a.uid);

      const picked = candidates[0];
      const msg = await client.fetchOne(picked.uid, { source: true, envelope: true }, { uid: true });
      const rawSource = msg?.source;
      if (!rawSource || !rawSource.length) return 'Тело письма пустое.';

      const parsed = await simpleParser(rawSource);
      const cleanText = parsed.text || '';

      if (!cleanText.trim()) return 'Не удалось извлечь читаемый текст из письма.';
      const compact = cleanText.slice(0, 3500);
      return `Письмо найдено: ${msg?.envelope?.subject || picked.subject}\n\n${compact}`;
    } finally {
      lock.release();
    }
  } catch (err: any) {
    return `Ошибка чтения письма: ${err?.message || String(err)}`;
  } finally {
    try { await client.logout(); } catch {}
  }
};

// ── Encryption helper for mail account management ──────────────────────────

const encryptSecret = (text: string) => {
  const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${EMAIL_PASSWORD_DELIMITER}${encrypted.toString('hex')}`;
};

export const resolveImapProviderConfig = (providerRaw: string) => {
  const provider = (providerRaw || '').trim().toLowerCase();
  if (['yandex', 'ya', 'яндекс'].includes(provider)) {
    return { provider: 'yandex' as MailProvider, host: 'imap.yandex.ru', port: 993, secure: 1 };
  }
  if (['google', 'gmail', 'гугл', 'googlemail'].includes(provider)) {
    return { provider: 'google' as MailProvider, host: 'imap.gmail.com', port: 993, secure: 1 };
  }
  return null;
};

export const detectMailProviderByEmail = (emailRaw: string): string | null => {
  const domain = (emailRaw || '').trim().toLowerCase().split('@')[1] || '';
  if (['gmail.com', 'googlemail.com', 'google.com'].includes(domain)) return 'google';
  if (['yandex.ru', 'yandex.com', 'ya.ru', 'narod.ru'].includes(domain)) return 'yandex';
  return null;
};

// ── Mail account CRUD (management) ────────────────────────────────────────

export const upsertMailAccount = (
  userId: number,
  provider: MailProvider,
  email: string,
  encryptedPassword: string,
  host: string,
  port = 993,
  secure = 1
) => db.prepare(`
  INSERT INTO mail_accounts (user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id, provider) DO UPDATE SET
    imap_user = excluded.imap_user,
    imap_pass = excluded.imap_pass,
    imap_host = excluded.imap_host,
    imap_port = excluded.imap_port,
    imap_secure = excluded.imap_secure,
    updated_at = CURRENT_TIMESTAMP
`).run(userId, provider, email, encryptedPassword, host, port, secure);

export const setActiveMailProvider = (userId: number, provider: MailProvider) => db.prepare(`
  UPDATE users SET imap_provider = ? WHERE id = ?
`).run(provider, userId);

export const updateUserMailSettings = (
  userId: number,
  provider: string,
  email: string,
  encryptedPassword: string,
  host: string,
  port = 993,
  secure = 1
) => db.prepare(`
  UPDATE users
  SET imap_provider = ?, imap_user = ?, imap_pass = ?, imap_host = ?, imap_port = ?, imap_secure = ?
  WHERE id = ?
`).run(provider, email, encryptedPassword, host, port, secure, userId);

export const updateUserMailCheckLimit = (userId: number, limit: number) => db.prepare(`
  UPDATE users SET mail_check_limit = ? WHERE id = ?
`).run(limit, userId);

export const deleteMailAccount = (userId: number, provider: MailProvider) => db
  .prepare(`DELETE FROM mail_accounts WHERE user_id = ? AND provider = ?`)
  .run(userId, provider);

export const clearUserMailSettings = (userId: number) => db.prepare(`
  UPDATE users
  SET imap_provider = NULL, imap_user = NULL, imap_pass = NULL, imap_host = NULL, imap_port = 993, imap_secure = 1
  WHERE id = ?
`).run(userId);

export const deleteAllMailAccounts = (userId: number) => db
  .prepare('DELETE FROM mail_accounts WHERE user_id = ?')
  .run(userId);

export { encryptSecret, getMailAccountsForUser, getMailAccountForUser, normalizeMailProvider };

export const runEmailSend = async (userId: number, to: string, subject: string, body: string, provider?: string ) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';
  const account = resolveUserMailAccount(userId, provider);
  if (!account) return 'Ошибка: почта не настроена.';

  const nodemailerMod = await optionalImport('nodemailer');
  const createTransport = (nodemailerMod as any)?.createTransport || (nodemailerMod as any)?.default?.createTransport || null;
  if (!createTransport) {
    return 'Ошибка: модуль nodemailer не установлен на сервере.';
  }

  const normalizedTo = (to || '').trim();
  const normalizedSubject = (subject || '').trim();
  const normalizedBody = (body || '').trim();
  if (!normalizedTo || !normalizedSubject || !normalizedBody) {
    return 'Ошибка: нужны to, subject и body.';
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedTo)) return 'Ошибка: некорректный email получателя.';

  let decryptedPass = '';
  try {
    decryptedPass = decryptSecret(account.imap_pass);
  } catch (err: any) {
    return `Ошибка: не удалось расшифровать пароль почты (${err?.message || String(err)}).`;
  }

  const smtpHost = account.imap_host.includes('imap')
    ? account.imap_host.replace('imap', 'smtp')
    : account.provider === 'google'
      ? 'smtp.gmail.com'
      : 'smtp.yandex.ru';

  const transporter = createTransport({
    host: smtpHost,
    port: 465,
    secure: true,
    auth: {
      user: account.imap_user,
      pass: decryptedPass
    }
  });

  try {
    await transporter.sendMail({
      from: account.imap_user,
      to: normalizedTo,
      subject: normalizedSubject,
      text: normalizedBody,
      html: normalizedBody
    });
    return `✅ Письмо успешно отправлено на ${normalizedTo}`;
  } catch (err: any) {
    return `❌ Ошибка отправки: ${err?.message || String(err)}`;
  }
};

