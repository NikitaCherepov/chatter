import express from 'express';
import dotenv from 'dotenv';
import { adminMiddleware, authMiddleware, issueAuthTokens, makePasswordHash, refreshAccessToken, validateTelegramInitData, verifyPassword, type AuthedRequest } from './auth.js';
import { activateUserChat, bindChatMessageTelegramMeta, createApiAccount, createOrUpdateUserForApiRegistration, createUserChat, ensureActiveChat, getApiAccountByLogin, getChatMessages, getUserById, listUserChats, upsertUserFromTelegram } from './services/chats.js';
import { createNote, countNotes, deleteNote, getNoteById, listNotes } from './services/notes.js';
import { createTask, deletePendingTask, listTasks } from './services/tasks.js';
import { sendMessageThroughAi } from './services/ai.js';
import { db } from './db.js';
import { getCleanTextFromUrl } from './services/web-reader.js';
import { startTaskScheduler } from './services/scheduler.js';
import { runVoiceTurn } from './services/voice.js';

dotenv.config();

const app = express();
const PORT = Number.parseInt(process.env.BACKEND_API_PORT || '3050', 10) || 3050;
const BACKEND_INTERNAL_TOKEN = `${process.env.BACKEND_INTERNAL_TOKEN || ''}`.trim();

app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'backend-api', now: Math.floor(Date.now() / 1000) });
});

const internalAuth = (req: any, res: any, next: any) => {
  if (!BACKEND_INTERNAL_TOKEN) return res.status(503).json({ error: 'internal_token_not_configured' });
  const authHeader = `${req.headers.authorization || ''}`;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token !== BACKEND_INTERNAL_TOKEN) return res.status(401).json({ error: 'unauthorized_internal' });
  next();
};

const BACKEND_VOICE_API_ENABLED = `${process.env.BACKEND_VOICE_API_ENABLED || '0'}`.trim() === '1';

app.post('/internal/tools/read_url', internalAuth, async (req, res) => {
  const url = `${req.body?.url || ''}`.trim();
  if (!url) return res.status(400).json({ error: 'url_required' });
  try {
    const cleanText = await getCleanTextFromUrl(url);
    return res.json({ ok: true, url, text: cleanText });
  } catch (err: any) {
    return res.status(422).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/internal/ai/send', internalAuth, async (req, res) => {
  const userId = Number(req.body?.user_id);
  const text = `${req.body?.text || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;
  const optionsRaw = req.body?.options || {};
  const options = {
    forcePro: Boolean(optionsRaw.forcePro),
    ignoreDailyLimit: Boolean(optionsRaw.ignoreDailyLimit),
    countAsUserMessage: optionsRaw.countAsUserMessage === false ? false : true,
    skipHistory: Boolean(optionsRaw.skipHistory),
    persistUserText: typeof optionsRaw.persistUserText === 'string' ? optionsRaw.persistUserText : undefined,
    userTelegramChatId: Number.isFinite(Number(optionsRaw.userTelegramChatId)) ? Math.floor(Number(optionsRaw.userTelegramChatId)) : null,
    userTelegramMessageId: Number.isFinite(Number(optionsRaw.userTelegramMessageId)) ? Math.floor(Number(optionsRaw.userTelegramMessageId)) : null,
    assistantTelegramChatId: Number.isFinite(Number(optionsRaw.assistantTelegramChatId)) ? Math.floor(Number(optionsRaw.assistantTelegramChatId)) : null
  };

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!text.trim()) return res.status(400).json({ error: 'empty_text' });

  try {
    const result = await sendMessageThroughAi(Math.floor(userId), text, chatId, options);
    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'ai_send_failed'}`;
    if (code === 'user_not_approved') return res.status(403).json({ error: code });
    if (code === 'daily_message_limit_reached') return res.status(429).json({ error: code });
    if (code === 'empty_text') return res.status(400).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.post('/internal/messages/bind-telegram', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const messageId = Number(req.body?.message_id);
  const telegramChatId = Number.isFinite(Number(req.body?.telegram_chat_id))
    ? Math.floor(Number(req.body?.telegram_chat_id))
    : null;
  const telegramMessageId = Number.isFinite(Number(req.body?.telegram_message_id))
    ? Math.floor(Number(req.body?.telegram_message_id))
    : null;

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });

  const result = bindChatMessageTelegramMeta(Math.floor(userId), Math.floor(messageId), telegramChatId, telegramMessageId);
  if (!result.changes) return res.status(404).json({ error: 'message_not_found' });
  return res.json({ ok: true });
});

app.post('/internal/voice/turn', internalAuth, async (req, res) => {
  if (!BACKEND_VOICE_API_ENABLED) {
    return res.status(503).json({ error: 'backend_voice_api_disabled' });
  }

  const userId = Number(req.body?.user_id);
  const audioBase64 = `${req.body?.audio_base64 || ''}`;
  const mimeType = `${req.body?.mime_type || 'audio/ogg'}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;
  const optionsRaw = req.body?.options || {};

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!audioBase64.trim()) return res.status(400).json({ error: 'empty_audio' });

  try {
    const result = await runVoiceTurn(
      Math.floor(userId),
      audioBase64,
      mimeType,
      chatId,
      {
        userTelegramChatId: Number.isFinite(Number(optionsRaw.userTelegramChatId)) ? Math.floor(Number(optionsRaw.userTelegramChatId)) : null,
        userTelegramMessageId: Number.isFinite(Number(optionsRaw.userTelegramMessageId)) ? Math.floor(Number(optionsRaw.userTelegramMessageId)) : null,
        assistantTelegramChatId: Number.isFinite(Number(optionsRaw.assistantTelegramChatId)) ? Math.floor(Number(optionsRaw.assistantTelegramChatId)) : null
      }
    );
    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'voice_turn_failed'}`;
    if (code === 'user_not_approved') return res.status(403).json({ error: code });
    if (code === 'daily_message_limit_reached') return res.status(429).json({ error: code });
    if (code === 'empty_audio') return res.status(400).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.post('/api/v1/auth/register', (req, res) => {
  const login = `${req.body?.login || ''}`.trim().toLowerCase();
  const password = `${req.body?.password || ''}`;
  const name = `${req.body?.name || ''}`.trim() || null;

  if (!/^[-_.a-z0-9]{3,64}$/i.test(login)) return res.status(400).json({ error: 'bad_login' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'bad_password_length' });

  if (getApiAccountByLogin(login)) return res.status(409).json({ error: 'login_already_exists' });

  const userId = createOrUpdateUserForApiRegistration(name);
  const hashed = makePasswordHash(password);
  createApiAccount(userId, login, hashed.salt, hashed.hash);

  const user = getUserById(userId);
  if (!user) return res.status(500).json({ error: 'user_create_failed' });

  const tokens = issueAuthTokens(userId);
  return res.status(201).json({
    ...tokens,
    user: {
      id: user.id,
      name: user.name,
      username: user.tg_username,
      role: user.role,
      is_admin: user.is_admin,
      plan: user.plan
    }
  });
});

app.post('/api/v1/auth/login', (req, res) => {
  const login = `${req.body?.login || ''}`.trim().toLowerCase();
  const password = `${req.body?.password || ''}`;

  if (!login || !password) return res.status(400).json({ error: 'login_password_required' });
  const account = getApiAccountByLogin(login);
  if (!account) return res.status(401).json({ error: 'invalid_credentials' });
  if (!verifyPassword(password, account.password_salt, account.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const user = getUserById(account.user_id);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  if (user.status !== 'approved' && user.is_admin !== 1) {
    return res.status(403).json({ error: 'access_not_approved', status: user.status });
  }

  const tokens = issueAuthTokens(user.id);
  return res.json({
    ...tokens,
    user: {
      id: user.id,
      name: user.name,
      username: user.tg_username,
      role: user.role,
      is_admin: user.is_admin,
      plan: user.plan
    }
  });
});

app.post('/api/v1/auth/telegram', (req, res) => {
  const initData = `${req.body?.initData || ''}`.trim();
  if (!initData) return res.status(400).json({ error: 'initData_required' });

  const validated = validateTelegramInitData(initData);
  if (!validated.ok) return res.status(401).json({ error: 'invalid_init_data', reason: validated.reason });

  const user = validated.user;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;
  upsertUserFromTelegram(user.id, user.username || null, fullName);

  const userRecord = getUserById(user.id);
  if (!userRecord) return res.status(500).json({ error: 'user_create_failed' });
  if (userRecord.status !== 'approved' && userRecord.is_admin !== 1) {
    return res.status(403).json({ error: 'access_not_approved', status: userRecord.status });
  }

  const tokens = issueAuthTokens(user.id);
  return res.json({
    ...tokens,
    user: {
      id: userRecord.id,
      name: userRecord.name,
      username: userRecord.tg_username,
      role: userRecord.role,
      is_admin: userRecord.is_admin,
      plan: userRecord.plan
    }
  });
});

app.post('/api/v1/auth/refresh', (req, res) => {
  const refresh = `${req.body?.refresh_token || ''}`.trim();
  if (!refresh) return res.status(400).json({ error: 'refresh_token_required' });
  const tokens = refreshAccessToken(refresh);
  if (!tokens) return res.status(401).json({ error: 'invalid_refresh_token' });
  return res.json(tokens);
});

app.use('/api/v1', authMiddleware);

app.get('/api/v1/chats', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const chats = listUserChats(userId);
  const activeChatId = ensureActiveChat(userId);
  res.json({ chats, active_chat_id: activeChatId });
});

app.post('/api/v1/chats', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const title = `${req.body?.title || ''}`;
  const chatId = createUserChat(userId, title);
  res.status(201).json({ chat_id: chatId });
});

app.post('/api/v1/chats/:id/activate', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const ok = activateUserChat(userId, chatId);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true, active_chat_id: chatId });
});

app.get('/api/v1/chats/:id/messages', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const messages = getChatMessages(userId, chatId, limit, offset);
  res.json({ messages, limit: Math.max(1, Math.min(100, limit || 20)), offset: Math.max(0, offset || 0) });
});

app.post('/api/v1/chat/send', async (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const text = `${req.body?.text || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;

  try {
    const result = await sendMessageThroughAi(userId, text, chatId);
    res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'ai_send_failed'}`;
    if (code === 'user_not_approved') return res.status(403).json({ error: code });
    if (code === 'daily_message_limit_reached') return res.status(429).json({ error: code });
    if (code === 'empty_text') return res.status(400).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.get('/api/v1/notes', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const query = `${req.query.query || ''}`;
  const notes = listNotes(userId, limit, offset, query);
  const total = countNotes(userId, query);
  res.json({ notes, total, limit: Math.max(1, Math.min(50, limit || 20)), offset: Math.max(0, offset || 0) });
});

app.post('/api/v1/notes', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const title = `${req.body?.title || ''}`;
  const content = `${req.body?.content || ''}`;

  const created = createNote(userId, user.plan, title, content);
  if (!created.ok) {
    if (created.error === 'content_required') return res.status(400).json({ error: created.error });
    if (created.error === 'title_too_long' || created.error === 'content_too_long' || created.error === 'notes_limit') return res.status(422).json({ error: created.error });
    return res.status(400).json({ error: created.error });
  }
  return res.status(201).json({ note_id: created.id });
});

app.delete('/api/v1/notes/:id', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_note_id' });
  const ok = deleteNote(userId, noteId);
  if (!ok) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ ok: true });
});

app.get('/api/v1/notes/:id', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_note_id' });
  const note = getNoteById(userId, noteId);
  if (!note) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ note });
});

app.get('/api/v1/tasks', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const statusRaw = `${req.query.status || 'pending'}` as 'pending' | 'done' | 'error' | 'all';
  const status = ['pending', 'done', 'error', 'all'].includes(statusRaw) ? statusRaw : 'pending';
  const limit = Number.parseInt(`${req.query.limit || '50'}`, 10);
  const tasks = listTasks(userId, limit, status);
  res.json({ tasks });
});

app.post('/api/v1/tasks', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const executeAt = Number(req.body?.execute_at);
  const taskType = `${req.body?.task_type || ''}` as any;
  const payload = `${req.body?.payload || ''}`;
  const recurrenceType = `${req.body?.recurrence_type || 'once'}` as any;
  const recurrenceWeekday = Number.isFinite(Number(req.body?.recurrence_weekday))
    ? Math.floor(Number(req.body?.recurrence_weekday))
    : null;
  const timezoneOffset = Number.isFinite(Number(req.body?.timezone_offset))
    ? Math.floor(Number(req.body?.timezone_offset))
    : null;
  const notifyMode = `${req.body?.notify_mode || 'always'}` as any;
  const notifyCondition = req.body?.notify_condition == null ? null : `${req.body.notify_condition}`;

  if (!Number.isFinite(executeAt) || executeAt <= 0) return res.status(400).json({ error: 'bad_execute_at' });
  if (!payload.trim()) return res.status(400).json({ error: 'payload_required' });

  const taskId = createTask(userId, Math.floor(executeAt), taskType, payload, recurrenceType, recurrenceWeekday, timezoneOffset, notifyMode, notifyCondition);
  return res.status(201).json({ task_id: taskId });
});

app.delete('/api/v1/tasks/:id', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const taskId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId) || taskId <= 0) return res.status(400).json({ error: 'bad_task_id' });
  const ok = deletePendingTask(userId, taskId);
  if (!ok) return res.status(404).json({ error: 'task_not_found_or_not_pending' });
  return res.json({ ok: true });
});

app.get('/api/v1/admin/users', adminMiddleware, (_req: AuthedRequest, res) => {
  const rows = db.prepare(`
    SELECT id, name, role, is_admin, status, plan, tg_username
    FROM users
    ORDER BY id ASC
    LIMIT 500
  `).all();
  res.json({ users: rows });
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`[backend-api] started on :${PORT}`);
  startTaskScheduler();
});
