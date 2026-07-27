import crypto from 'node:crypto';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import { getUserById } from './chats.js';
import { getEncryptionKey } from '../utils/encryption.js';
import { wrapUntrustedContent } from './web-reader.js';

export type MailProvider = 'yandex' | 'google' | 'custom';

export type MailAccountRecord = {
  id: number;
  user_id: number;
  provider: MailProvider;
  label: string | null;
  email: string;
  imap_user: string;
  imap_pass: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
};

const ENCRYPTION_IV_LENGTH = 16;
const EMAIL_PASSWORD_DELIMITER = '::';
export const MAIL_RESULTS_HARD_LIMIT = 50;
export const MAIL_RESULTS_DEFAULT_LIMIT = 10;

export type MailConnectionConfig = {
  login: string;
  imapHost: string;
  imapPort: number;
  imapSecure: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: number;
};

const decryptSecret = (text: string) => {
  const parts = text.split(EMAIL_PASSWORD_DELIMITER);
  if (parts.length !== 2) throw new Error('Неверный формат секрета');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
};

const normalizeMailProvider = (providerRaw: string | null | undefined): MailProvider | null => {
  const provider = (providerRaw || '').trim().toLowerCase();
  if (['yandex', 'ya', 'яндекс'].includes(provider)) return 'yandex';
  if (['google', 'gmail', 'гугл', 'googlemail'].includes(provider)) return 'google';
  if (['custom', 'other', 'другое', 'другая'].includes(provider)) return 'custom';
  return null;
};

const getMailAccountsForUser = (userId: number) => db.prepare(`
  SELECT id, user_id, provider, label, email, imap_user, imap_pass, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure
  FROM mail_accounts
  WHERE user_id = ?
  ORDER BY id ASC
`).all(userId) as MailAccountRecord[];

const getMailAccountById = (userId: number, accountId: number) => db.prepare(`
  SELECT id, user_id, provider, label, email, imap_user, imap_pass, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure
  FROM mail_accounts
  WHERE user_id = ? AND id = ?
`).get(userId, accountId) as MailAccountRecord | undefined;

const getMailAccountsByProvider = (userId: number, provider: MailProvider) => getMailAccountsForUser(userId)
  .filter(account => account.provider === provider);

const getMailAccountForUser = (userId: number, provider: MailProvider) => {
  const accounts = getMailAccountsByProvider(userId, provider);
  return accounts.length === 1 ? accounts[0] : undefined;
};

export const resolveUserMailAccount = (
  userId: number,
  preferredProviderRaw?: string | null,
  preferredAccountIdRaw?: number | null
) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!user) return null;

  const preferredAccountId = Math.floor(Number(preferredAccountIdRaw));
  if (Number.isFinite(preferredAccountId) && preferredAccountId > 0) {
    return getMailAccountById(user.id, preferredAccountId) || null;
  }

  const preferredProvider = normalizeMailProvider(preferredProviderRaw);
  const activeAccountId = Math.floor(Number(user.active_mail_account_id));

  if (preferredProvider) {
    const providerAccounts = getMailAccountsByProvider(user.id, preferredProvider);
    if (providerAccounts.length === 1) return providerAccounts[0];
    if (providerAccounts.length > 1 && Number.isFinite(activeAccountId)) {
      return providerAccounts.find(account => account.id === activeAccountId) || null;
    }
    return null;
  }

  if (Number.isFinite(activeAccountId) && activeAccountId > 0) {
    const active = getMailAccountById(user.id, activeAccountId);
    if (active) return active;
  }

  const all = getMailAccountsForUser(user.id);
  if (all.length) return all[0];

  if (user.imap_user && user.imap_pass && user.imap_host) {
    const provider = normalizeMailProvider(user.imap_provider)
      || (String(user.imap_host).includes('gmail') ? 'google' : 'yandex');
    return {
      id: 0,
      user_id: user.id,
      provider,
      label: null,
      email: user.imap_user,
      imap_user: user.imap_user,
      imap_pass: user.imap_pass,
      imap_host: user.imap_host,
      imap_port: user.imap_port ?? 993,
      imap_secure: user.imap_secure ?? 1,
      smtp_host: provider === 'google' ? 'smtp.gmail.com' : 'smtp.yandex.com',
      smtp_port: 465,
      smtp_secure: 1
    } as MailAccountRecord;
  }

  return null;
};

export const resolveMailAccountReference = (userId: number, referenceRaw: string) => {
  const reference = `${referenceRaw || ''}`.trim().toLowerCase();
  if (!reference) return null;
  const accounts = getMailAccountsForUser(userId);
  const numericId = Number(reference);
  if (Number.isInteger(numericId) && numericId > 0) {
    return accounts.find(account => account.id === numericId) || null;
  }
  const exact = accounts.find(account => account.email.toLowerCase() === reference)
    || accounts.find(account => account.label?.trim().toLowerCase() === reference);
  if (exact) return exact;
  const provider = normalizeMailProvider(reference);
  if (!provider) return null;
  const providerAccounts = accounts.filter(account => account.provider === provider);
  if (providerAccounts.length === 1) return providerAccounts[0];
  const user = db.prepare('SELECT active_mail_account_id FROM users WHERE id = ?').get(userId) as { active_mail_account_id?: number } | undefined;
  return providerAccounts.find(account => account.id === Number(user?.active_mail_account_id)) || null;
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
  dateTo?: string,
  mailAccountId?: number
 ) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';
  const account = resolveUserMailAccount(userId, provider, mailAccountId);
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
  const desiredLimit = requestedLimit > 0 ? requestedLimit : MAIL_RESULTS_DEFAULT_LIMIT;
  const safeLimit = Math.max(1, Math.min(MAIL_RESULTS_HARD_LIMIT, desiredLimit));
  const safeOffset = Math.max(0, Math.min(500, Math.floor(offset || 0)));
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

      const useServerSearch = Boolean(normalizedQuery || dateFromNorm || dateToNorm);
      let fetchRange: string | number[];
      let totalMatches = total;

      if (useServerSearch) {
        const searchCriteria: Record<string, unknown> = {};
        if (normalizedQuery) {
          searchCriteria.or = [
            { from: normalizedQuery },
            { subject: normalizedQuery },
            { text: normalizedQuery }
          ];
        }
        if (dateFromNorm) searchCriteria.since = dateFromNorm;
        if (dateToNorm) {
          const exclusiveEnd = new Date(`${dateToNorm}T00:00:00Z`);
          exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
          searchCriteria.before = exclusiveEnd.toISOString().slice(0, 10);
        }

        const foundUidsRaw = await client.search(searchCriteria, { uid: true });
        const foundUids = Array.isArray(foundUidsRaw)
          ? foundUidsRaw.map(Number).filter(Number.isFinite).sort((left, right) => right - left)
          : [];
        totalMatches = foundUids.length;
        fetchRange = foundUids.slice(safeOffset, safeOffset + safeLimit);
      } else {
        const fetchWindow = Math.min(500, safeLimit + safeOffset);
        const startSeq = Math.max(1, total - fetchWindow + 1);
        fetchRange = `${startSeq}:${total}`;
      }

      if (Array.isArray(fetchRange) && !fetchRange.length) {
        if (normalizedQuery) return `Ничего не найдено по запросу "${normalizedQuery}".`;
        if (dateFromNorm || dateToNorm) return 'Писем в указанном диапазоне нет.';
        return `Ничего не найдено (offset=${safeOffset}, limit=${safeLimit}).`;
      }

      const collected: Array<{ uid: number; message_uid: number; from: string; subject: string; date: string; date_unix: number | null }> = [];
      const messages = useServerSearch
        ? client.fetch(fetchRange, { envelope: true }, { uid: true })
        : client.fetch(fetchRange, { envelope: true });

      for await (const msg of messages) {
        const envelope = msg.envelope;
        const fromAddress = envelope?.from?.[0]?.address || envelope?.from?.[0]?.name || 'unknown';
        const subject = envelope?.subject || '(без темы)';
        const date = envelope?.date instanceof Date ? envelope.date : null;
        const dateUnix = date ? Math.floor(date.getTime() / 1000) : null;

        collected.push({
          uid: Number(msg.uid || 0),
          message_uid: Number(msg.uid || 0),
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
      const sliced = useServerSearch ? sorted : sorted.slice(safeOffset, safeOffset + safeLimit);
      if (!sliced.length) return `Ничего не найдено (offset=${safeOffset}, limit=${safeLimit}).`;

      return wrapUntrustedContent(JSON.stringify({
        mail_account_id: account.id,
        label: account.label,
        provider: account.provider,
        account: account.imap_user,
        total_matches: totalMatches,
        offset: safeOffset,
        limit: safeLimit,
        items: sliced
      }, null, 2));
    } finally {
      lock.release();
    }
  } catch (err: any) {
    return `Ошибка IMAP: ${err?.message || String(err)}`;
  } finally {
    try { await client.logout(); } catch {}
  }
};

export const runEmailRead = async (userId: number, subjectPart: string, provider?: string, messageUid?: number, mailAccountId?: number ) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';
  const account = resolveUserMailAccount(userId, provider, mailAccountId);
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
  const normalizedUid = Number.isFinite(Number(messageUid)) && Number(messageUid) > 0
    ? Math.floor(Number(messageUid))
    : null;
  if (!normalizedSubject && !normalizedUid) return 'Ошибка: нужен message_uid или subject_part.';

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

      let msg: any;
      let pickedSubject = normalizedSubject;

      if (normalizedUid) {
        msg = await client.fetchOne(normalizedUid, { source: true, envelope: true }, { uid: true });
        if (!msg) return `Письмо с UID ${normalizedUid} не найдено.`;
      } else {
        const foundUidsRaw = await client.search({ subject: normalizedSubject }, { uid: true });
        const foundUids = Array.isArray(foundUidsRaw)
          ? foundUidsRaw.map(Number).filter(Number.isFinite).sort((left, right) => right - left)
          : [];
        if (!foundUids.length) return `Письмо по теме "${normalizedSubject}" не найдено.`;
        msg = await client.fetchOne(foundUids[0], { source: true, envelope: true }, { uid: true });
        if (!msg) return `Письмо по теме "${normalizedSubject}" не найдено.`;
        pickedSubject = msg.envelope?.subject || normalizedSubject;
      }

      const rawSource = msg?.source;
      if (!rawSource || !rawSource.length) return 'Тело письма пустое.';

      const parsed = await simpleParser(rawSource);
      const cleanText = parsed.text || '';

      if (!cleanText.trim()) return 'Не удалось извлечь читаемый текст из письма.';
      const compact = cleanText.slice(0, 3500);
      return wrapUntrustedContent(`Письмо найдено: ${msg?.envelope?.subject || pickedSubject}\n\n${compact}`);
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
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${EMAIL_PASSWORD_DELIMITER}${encrypted.toString('hex')}`;
};

export const resolveImapProviderConfig = (providerRaw: string) => {
  const provider = (providerRaw || '').trim().toLowerCase();
  if (['yandex', 'ya', 'яндекс'].includes(provider)) {
    return {
      provider: 'yandex' as MailProvider,
      imapHost: 'imap.yandex.com', imapPort: 993, imapSecure: 1,
      smtpHost: 'smtp.yandex.com', smtpPort: 465, smtpSecure: 1
    };
  }
  if (['google', 'gmail', 'гугл', 'googlemail'].includes(provider)) {
    return {
      provider: 'google' as MailProvider,
      imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 1,
      smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 1
    };
  }
  return null;
};

export const normalizeMailAppPassword = (provider: MailProvider, passwordRaw: string) => {
  const password = `${passwordRaw || ''}`.trim();
  // Google displays app passwords in four-character groups. IMAP expects the
  // actual 16-character password without visual separators.
  return provider === 'google' ? password.replace(/\s+/g, '') : password;
};

const normalizePort = (value: unknown, fallback: number) => {
  const port = Math.floor(Number(value));
  return Number.isFinite(port) && port >= 1 && port <= 65_535 ? port : fallback;
};

const isPrivateAddress = (addressRaw: string) => {
  const address = addressRaw.toLowerCase();
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 0
      || parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || parts[0] >= 224;
  }
  if (net.isIPv6(address)) {
    return address === '::' || address === '::1'
      || address.startsWith('fc') || address.startsWith('fd')
      || address.startsWith('fe8') || address.startsWith('fe9')
      || address.startsWith('fea') || address.startsWith('feb')
      || address.startsWith('::ffff:127.')
      || address.startsWith('::ffff:10.')
      || address.startsWith('::ffff:192.168.');
  }
  return true;
};

const validateCustomMailHost = async (hostRaw: string) => {
  const host = `${hostRaw || ''}`.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || /[\s/:]/.test(host) || host === 'localhost' || host.endsWith('.local')) {
    throw new Error('bad_mail_host');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('bad_mail_host');
  }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('private_mail_host_forbidden');
  }
  return host;
};

export const verifyMailAccountConnection = async (
  provider: MailProvider,
  emailRaw: string,
  appPasswordRaw: string,
  customConfig?: Partial<MailConnectionConfig>
) => {
  const email = `${emailRaw || ''}`.trim();
  const appPassword = normalizeMailAppPassword(provider, appPasswordRaw);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('bad_email');
  if (!appPassword) throw new Error('app_password_required');

  const preset = resolveImapProviderConfig(provider);
  let config: MailConnectionConfig;
  if (provider === 'custom') {
    const imapHost = await validateCustomMailHost(`${customConfig?.imapHost || ''}`);
    const smtpHost = await validateCustomMailHost(`${customConfig?.smtpHost || ''}`);
    config = {
      login: `${customConfig?.login || email}`.trim(),
      imapHost,
      imapPort: normalizePort(customConfig?.imapPort, 993),
      imapSecure: customConfig?.imapSecure === 0 ? 0 : 1,
      smtpHost,
      smtpPort: normalizePort(customConfig?.smtpPort, 465),
      smtpSecure: customConfig?.smtpSecure === 0 ? 0 : 1
    };
  } else {
    if (!preset) throw new Error('bad_provider');
    config = {
      login: email,
      imapHost: preset.imapHost,
      imapPort: preset.imapPort,
      imapSecure: preset.imapSecure,
      smtpHost: preset.smtpHost,
      smtpPort: preset.smtpPort,
      smtpSecure: preset.smtpSecure
    };
  }
  if (!config.login) throw new Error('mail_login_required');

  const imapflowMod = await optionalImport('imapflow');
  const ImapFlow = (imapflowMod as any)?.ImapFlow || (imapflowMod as any)?.default?.ImapFlow || (imapflowMod as any)?.default || null;
  if (!ImapFlow) throw new Error('mail_runtime_unavailable');

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure === 1,
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    auth: { user: config.login, pass: appPassword }
  });

  try {
    await client.connect();
  } catch (error: any) {
    const message = `${error?.message || ''}`;
    if (/auth|credential|login|password|invalid user|authenticationfailed/i.test(message)) {
      throw new Error('mail_auth_failed');
    }
    throw new Error('mail_connection_failed');
  } finally {
    try { await client.logout(); } catch {}
  }

  const nodemailerMod = await optionalImport('nodemailer');
  const createTransport = (nodemailerMod as any)?.createTransport || (nodemailerMod as any)?.default?.createTransport || null;
  if (!createTransport) throw new Error('mail_runtime_unavailable');
  const transporter = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure === 1,
    requireTLS: config.smtpSecure !== 1,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    auth: { user: config.login, pass: appPassword }
  });
  try {
    await transporter.verify();
  } catch (error: any) {
    const message = `${error?.message || ''}`;
    if (/auth|credential|login|password|invalid user|authenticationfailed/i.test(message)) {
      throw new Error('mail_smtp_auth_failed');
    }
    throw new Error('mail_smtp_connection_failed');
  } finally {
    try { transporter.close(); } catch {}
  }

  return { email, appPassword, config };
};

export const detectMailProviderByEmail = (emailRaw: string): string | null => {
  const domain = (emailRaw || '').trim().toLowerCase().split('@')[1] || '';
  if (['gmail.com', 'googlemail.com', 'google.com'].includes(domain)) return 'google';
  if (['yandex.ru', 'yandex.com', 'ya.ru', 'narod.ru'].includes(domain)) return 'yandex';
  return null;
};

// ── Mail account CRUD (management) ────────────────────────────────────────

export const upsertMailAccount = (input: {
  userId: number;
  accountId?: number | null;
  provider: MailProvider;
  label?: string | null;
  email: string;
  encryptedPassword: string;
  config: MailConnectionConfig;
}) => {
  const label = `${input.label || ''}`.trim().slice(0, 80) || null;
  const email = input.email.trim().toLowerCase();
  const existing = input.accountId
    ? getMailAccountById(input.userId, input.accountId)
    : db.prepare('SELECT id FROM mail_accounts WHERE user_id = ? AND lower(email) = lower(?)')
      .get(input.userId, email) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE mail_accounts
      SET provider = ?, label = ?, email = ?, imap_user = ?, imap_pass = ?,
          imap_host = ?, imap_port = ?, imap_secure = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(
      input.provider, label, email, input.config.login, input.encryptedPassword,
      input.config.imapHost, input.config.imapPort, input.config.imapSecure,
      input.config.smtpHost, input.config.smtpPort, input.config.smtpSecure,
      existing.id, input.userId
    );
    return getMailAccountById(input.userId, existing.id)!;
  }

  const result = db.prepare(`
    INSERT INTO mail_accounts (
      user_id, provider, label, email, imap_user, imap_pass, imap_host, imap_port, imap_secure,
      smtp_host, smtp_port, smtp_secure, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    input.userId, input.provider, label, email, input.config.login, input.encryptedPassword,
    input.config.imapHost, input.config.imapPort, input.config.imapSecure,
    input.config.smtpHost, input.config.smtpPort, input.config.smtpSecure
  );
  return getMailAccountById(input.userId, Number(result.lastInsertRowid))!;
};

export const setActiveMailAccount = (userId: number, account: MailAccountRecord) => db.prepare(`
  UPDATE users
  SET active_mail_account_id = ?, imap_provider = ?, imap_user = ?, imap_pass = ?,
      imap_host = ?, imap_port = ?, imap_secure = ?
  WHERE id = ?
`).run(
  account.id, account.provider, account.imap_user, account.imap_pass,
  account.imap_host, account.imap_port, account.imap_secure, userId
);

export const deleteMailAccount = (userId: number, accountId: number) => db
  .prepare('DELETE FROM mail_accounts WHERE user_id = ? AND id = ?')
  .run(userId, accountId);

export const clearUserMailSettings = (userId: number) => db.prepare(`
  UPDATE users
  SET active_mail_account_id = NULL, imap_provider = NULL, imap_user = NULL, imap_pass = NULL,
      imap_host = NULL, imap_port = 993, imap_secure = 1
  WHERE id = ?
`).run(userId);

export const deleteAllMailAccounts = (userId: number) => db
  .prepare('DELETE FROM mail_accounts WHERE user_id = ?')
  .run(userId);

export { encryptSecret, getMailAccountsForUser, getMailAccountById, getMailAccountForUser, normalizeMailProvider };

export const runEmailSend = async (userId: number, to: string, subject: string, body: string, provider?: string, mailAccountId?: number ) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';
  const account = resolveUserMailAccount(userId, provider, mailAccountId);
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

  const transporter = createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure === 1,
    auth: {
      user: account.imap_user,
      pass: decryptedPass
    }
  });

  try {
    await transporter.sendMail({
      from: account.email,
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
