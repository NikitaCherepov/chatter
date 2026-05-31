import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { wsClients, registerWsClient, unregisterWsClient, type WsClient } from './ws-clients.js';
import { adminMiddleware, authMiddleware, issueAuthTokens, makePasswordHash, refreshAccessToken, validateTelegramInitData, verifyPassword, verifyToken, type AuthedRequest } from './auth.js';
import { activateUserChat, bindChatMessageTelegramMeta, createApiAccount, createOrUpdateUserForApiRegistration, createUserChat, ensureActiveChat, getApiAccountByLogin, getChatMessages, getUserById, listUserChats, upsertUserFromTelegram, setUserTimezone, updateUserContextWindow, updateUserContextWindowMax, updateUserPrompt, selectUserCustomPrompt, updateUserCustomPrompt, resetUsersPromptIfDeleted, resetDailyMessageCounters, upsertTelegramUser, createPendingTelegramUser, updateUserStatus, updateUserRole, updateUserName, updateUserTelegramUsername, removeUser, getAllUsers, getUsersCount, getUsersPage, getPendingUsersCount, getPendingUsersPage, getBannedUsersCount, getBannedUsersPage, updateUserPlan, syncAllUsersPlanLimits, ADMIN_IDS, generateLinkCode, verifyLinkCode, getLinkCodeForUser, renameUserChat, deleteUserChat, deleteUserMessage, searchUserChats } from './services/chats.js';
import { createNote, countNotes, deleteNote, getNoteById, listNotes } from './services/notes.js';
import { createTask, deletePendingTask, listTasks } from './services/tasks.js';
import { listMapPins, getMapPinById, createMapPin, updateMapPin, deleteMapPin } from './services/map-pins.js';
import { sendMessageThroughAi, generateAdminOutreach, callLiteAi } from './services/ai.js';
import { listMacros, getMacroById, getEnabledMacros, createMacro, updateMacro, deleteMacro } from './services/macros.js';
import { runImageGeneration } from './services/image-generation.js';
import { db } from './db.js';
import { getCleanTextFromUrl } from './services/web-reader.js';
import { startTaskScheduler } from './services/scheduler.js';
import { runVoiceTurn } from './services/voice.js';
import { runPhotoAnalyzeTurn } from './services/photo.js';
import { VectorMemoryService } from './services/vector-memory.js';
import { getAllPrompts, getPromptById, createPrompt, updatePromptName, updatePromptDescription, updatePromptContent, setDefaultPrompt, deletePrompt } from './services/prompts.js';
import { upsertMailAccount, setActiveMailProvider, updateUserMailSettings, updateUserMailCheckLimit, deleteMailAccount, clearUserMailSettings, deleteAllMailAccounts, getMailAccountsForUser, getMailAccountForUser, normalizeMailProvider, resolveImapProviderConfig, detectMailProviderByEmail, encryptSecret } from './services/mail.js';
import type { MailProvider } from './services/mail.js';
import { setBan, removeBan, getBanRecord } from './services/bans.js';
import { resolveImageFile, getUploadsDir } from './services/image-storage.js';

dotenv.config();

const app = express();
const PORT = Number.parseInt(process.env.BACKEND_API_PORT || '3050', 10) || 3050;
const BACKEND_INTERNAL_TOKEN = `${process.env.BACKEND_INTERNAL_TOKEN || ''}`.trim();

app.use(express.json({ limit: '20mb' }));

// CORS
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static updates for electron-updater
import fs from 'fs';

const updatesPath = path.join(__dirname, '../updates');
if (!fs.existsSync(updatesPath)) {
  fs.mkdirSync(updatesPath, { recursive: true });
  console.log(`[updates] created directory: ${updatesPath}`);
}
console.log(`[updates] serving from: ${updatesPath}`);
app.use('/updates', express.static(updatesPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.yml')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ── Static uploads for images ─────────────────────────────────────────────
const uploadsDir = getUploadsDir();
console.log(`[uploads] serving from: ${uploadsDir}`);
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '30d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000');
  }
}));

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
const BACKEND_PHOTO_API_ENABLED = `${process.env.BACKEND_PHOTO_API_ENABLED || '0'}`.trim() === '1';
const BACKEND_VECTOR_MEMORY_API_ENABLED = `${process.env.BACKEND_VECTOR_MEMORY_API_ENABLED || '0'}`.trim() === '1';

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

app.post('/internal/ai/admin-outreach', internalAuth, async (req, res) => {
  const targetUserId = Number(req.body?.target_user_id);
  const adminInstruction = `${req.body?.admin_instruction || ''}`;

  if (!Number.isFinite(targetUserId) || targetUserId <= 0) return res.status(400).json({ error: 'bad_target_user_id' });
  if (!adminInstruction.trim()) return res.status(400).json({ error: 'empty_instruction' });

  try {
    const result = await generateAdminOutreach(Math.floor(targetUserId), adminInstruction);
    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'admin_outreach_failed'}`;
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    if (code === 'empty_instruction') return res.status(400).json({ error: code });
    if (code === 'empty_ai_response') return res.status(502).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.post('/internal/ai/generate-image', internalAuth, async (req, res) => {
  const userId = Number(req.body?.user_id);
  const prompt = `${req.body?.prompt || ''}`.trim();

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!prompt) return res.status(400).json({ error: 'empty_prompt' });

  try {
    const result = await runImageGeneration(Math.floor(userId), prompt);
    if (!result.ok) {
      const errMsg = (result as any).error || 'image_gen_failed';
      if (errMsg === 'user_not_found') return res.status(404).json({ error: errMsg });
      if (errMsg === 'user_not_approved') return res.status(403).json({ error: errMsg });
      return res.status(422).json({ error: errMsg });
    }
    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'image_gen_failed'}`;
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

app.post('/internal/photo/analyze', internalAuth, async (req, res) => {
  if (!BACKEND_PHOTO_API_ENABLED) {
    return res.status(503).json({ error: 'backend_photo_api_disabled' });
  }

  const userId = Number(req.body?.user_id);
  const imageBase64 = `${req.body?.image_base64 || ''}`;
  const imageMimeType = `${req.body?.image_mime_type || 'image/jpeg'}`;
  const caption = `${req.body?.caption || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;
  const optionsRaw = req.body?.options || {};
  const extraImagesRaw: Array<any> = Array.isArray(req.body?.extra_images) ? req.body.extra_images : [];

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!imageBase64.trim()) return res.status(400).json({ error: 'empty_image' });

  const extraImages = extraImagesRaw
    .filter((img: any) => typeof img?.base64 === 'string' && img.base64.trim())
    .map((img: any) => ({
      base64: img.base64.trim(),
      mimeType: `${img.mime_type || 'image/jpeg'}`.trim() || 'image/jpeg'
    }));

  try {
    const result = await runPhotoAnalyzeTurn(
      Math.floor(userId),
      imageBase64,
      imageMimeType,
      caption,
      chatId,
      {
        userTelegramChatId: Number.isFinite(Number(optionsRaw.userTelegramChatId)) ? Math.floor(Number(optionsRaw.userTelegramChatId)) : null,
        userTelegramMessageId: Number.isFinite(Number(optionsRaw.userTelegramMessageId)) ? Math.floor(Number(optionsRaw.userTelegramMessageId)) : null,
        extraImages
      }
    );
    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'photo_analyze_failed'}`;
    if (code === 'user_not_approved') return res.status(403).json({ error: code });
    if (code === 'daily_message_limit_reached') return res.status(429).json({ error: code });
    if (code === 'empty_image') return res.status(400).json({ error: code });
    if (code === 'image_too_large') return res.status(413).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    if (code.startsWith('too_many_images')) return res.status(400).json({ error: code });
    if (code === 'images_not_allowed_for_plan') return res.status(403).json({ error: code });
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

// Return current authenticated user profile
app.get('/api/v1/auth/me', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ user });
});

// Resolve effective user: if web user has linked_tg_id, act as TG user
const effectiveUserId = (req: AuthedRequest): number => {
  const rawId = req.authUserId!;
  const user = getUserById(rawId);
  if (user?.linked_tg_id) return user.linked_tg_id;
  return rawId;
};

// ── Image download API (owner-only) ────────────────────────────────────────
app.get('/api/v1/images/:filename', authMiddleware, (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const filename = path.basename(req.params.filename || '');
  if (!filename) return res.status(400).json({ error: 'bad_filename' });

  const filepath = resolveImageFile(filename);
  if (!filepath) return res.status(404).json({ error: 'image_not_found' });

  // Verify ownership: check that this image belongs to a message owned by this user
  const row = db.prepare(`
    SELECT 1 FROM chat_messages
    WHERE user_id = ? AND images LIKE ?
    LIMIT 1
  `).get(userId, `%"${filename}"%`) as { 1: number } | undefined;

  if (!row) return res.status(403).json({ error: 'access_denied' });

  res.sendFile(filepath);
});

app.post('/api/v1/vector-memory/chunks', async (req: AuthedRequest, res) => {
  if (!BACKEND_VECTOR_MEMORY_API_ENABLED) {
    return res.status(503).json({ error: 'backend_vector_memory_api_disabled' });
  }
  const userId = effectiveUserId(req);
  const text = `${req.body?.text || ''}`;
  const source = `${req.body?.source || 'manual'}`;

  try {
    const saved = await VectorMemoryService.saveChunk(userId, text, source);
    return res.status(201).json(saved);
  } catch (err: any) {
    const code = `${err?.message || 'vector_memory_save_failed'}`;
    if (code === 'text_required') return res.status(400).json({ error: code });
    if (code.startsWith('text_too_long_max_')) return res.status(422).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.post('/api/v1/vector-memory/search', async (req: AuthedRequest, res) => {
  if (!BACKEND_VECTOR_MEMORY_API_ENABLED) {
    return res.status(503).json({ error: 'backend_vector_memory_api_disabled' });
  }
  const userId = effectiveUserId(req);
  const query = `${req.body?.query || ''}`;
  const topK = Number(req.body?.top_k);

  try {
    const found = await VectorMemoryService.search(userId, query, Number.isFinite(topK) ? topK : 3);
    return res.json(found);
  } catch (err: any) {
    const code = `${err?.message || 'vector_memory_search_failed'}`;
    if (code === 'query_required') return res.status(400).json({ error: code });
    if (code.startsWith('query_too_long_max_')) return res.status(422).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.delete('/api/v1/vector-memory/chunks/:id', async (req: AuthedRequest, res) => {
  if (!BACKEND_VECTOR_MEMORY_API_ENABLED) {
    return res.status(503).json({ error: 'backend_vector_memory_api_disabled' });
  }
  const userId = effectiveUserId(req);
  const chunkId = `${req.params.id || ''}`;

  try {
    const out = await VectorMemoryService.deleteChunk(userId, chunkId);
    return res.json(out);
  } catch (err: any) {
    const code = `${err?.message || 'vector_memory_delete_failed'}`;
    if (code === 'chunk_id_required') return res.status(400).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.delete('/api/v1/vector-memory/chunks', async (req: AuthedRequest, res) => {
  if (!BACKEND_VECTOR_MEMORY_API_ENABLED) {
    return res.status(503).json({ error: 'backend_vector_memory_api_disabled' });
  }
  if (`${req.query.all || ''}` !== '1') {
    return res.status(400).json({ error: 'set_all_1_to_confirm' });
  }
  const userId = effectiveUserId(req);

  try {
    const out = await VectorMemoryService.deleteAll(userId);
    return res.json(out);
  } catch (err: any) {
    const code = `${err?.message || 'vector_memory_delete_all_failed'}`;
    return res.status(500).json({ error: code });
  }
});

app.get('/api/v1/chats', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const chats = listUserChats(userId);
  const activeChatId = ensureActiveChat(userId);
  res.json({ chats, active_chat_id: activeChatId });
});

app.get('/api/v1/chats/search', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const query = `${req.query.q || ''}`.trim();
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);

  if (query.length < 3) return res.status(400).json({ error: 'query_too_short_min_3' });

  const results = searchUserChats(userId, query, limit);
  return res.json({ results });
});

app.post('/api/v1/chats', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const title = `${req.body?.title || ''}`;
  const chatId = createUserChat(userId, title);
  res.status(201).json({ chat_id: chatId });
});

app.post('/api/v1/chats/:id/activate', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const ok = activateUserChat(userId, chatId);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true, active_chat_id: chatId });
});

app.put('/api/v1/chats/:id/rename', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const title = `${req.body?.title || ''}`.trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  const ok = renameUserChat(userId, chatId, title);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true });
});

app.delete('/api/v1/chats/:chatId/messages/:messageId', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const chatId = Number.parseInt(req.params.chatId, 10);
  const messageId = Number.parseInt(req.params.messageId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });
  const ok = deleteUserMessage(userId, chatId, messageId);
  if (!ok) return res.status(404).json({ error: 'message_not_found' });
  return res.json({ ok: true });
});

app.get('/api/v1/chats/:id/messages', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const messages = getChatMessages(userId, chatId, limit, offset);
  res.json({ messages, limit: Math.max(1, Math.min(100, limit || 20)), offset: Math.max(0, offset || 0) });
});

app.post('/api/v1/chat/send', async (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const text = `${req.body?.text || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;

  // Parse optional images array
  const imagesRaw: Array<any> = Array.isArray(req.body?.images) ? req.body.images : [];
  const MAX_IMAGE_BYTES_API = 20 * 1024 * 1024;
  const images = imagesRaw
    .map((img: any) => {
      const base64 = `${img?.base64 || ''}`.trim();
      const mimeType = `${img?.mime_type || 'image/jpeg'}`.trim() || 'image/jpeg';
      return { base64, mimeType };
    })
    .filter(img => img.base64.length > 0);

  // Validate image sizes — обычные HTTP-ошибки до переключения на SSE
  for (const img of images) {
    const buf = Buffer.from(img.base64, 'base64');
    if (!buf.length) continue;
    if (buf.length > MAX_IMAGE_BYTES_API) {
      return res.status(413).json({ error: 'image_too_large' });
    }
  }

  // Save thumbnails for user images (before SSE starts)
  let savedUserImages: Array<{ url: string; type: 'user_photo' }> | null = null;
  if (images.length > 0) {
    try {
      const { saveUserImageThumbnail } = await import('./services/image-storage.js');
      const saved: Array<{ url: string; type: 'user_photo' }> = [];
      for (const img of images) {
        const result = await saveUserImageThumbnail(img.base64, img.mimeType);
        saved.push({ url: result.url, type: 'user_photo' });
      }
      savedUserImages = saved;
    } catch (err) {
      console.error('[chat/send] failed to save image thumbnails:', err);
    }
  }

  // Parse optional display manifest from desktop client
  const displayManifest = req.body?.display_manifest;
  const isDesktop = Boolean(req.body?.is_desktop);
  const isVoice = Boolean(req.body?.is_voice);

  // Load enabled macros from DB
  const enabledMacros = getEnabledMacros(userId);

  // SSE-заголовки
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // отключаем буферизацию nginx
  res.write(': connected\n\n');

  try {
    const apiUserId = req.authUserId!;
    const result = await sendMessageThroughAi(userId, text, chatId, {
      ...(images.length > 0 ? { images } : {}),
      userImages: savedUserImages,
      displayManifest,
      isDesktop,
      isVoice,
      activeMacros: enabledMacros,
      ...(apiUserId !== userId ? { promptUserId: apiUserId } : {}),
      onIntermediateMessage: (stepText) => {
        res.write(`event: intermediate\ndata: ${JSON.stringify({ text: stepText })}\n\n`);
      },
      onStateChange: (state) => {
        res.write(`event: display_state\ndata: ${JSON.stringify(state)}\n\n`);
      },
      onDesktopAction: (action) => {
        res.write(`event: desktop_action\ndata: ${JSON.stringify(action)}\n\n`);
      },
      onToolStatus: (statusText) => {
        res.write(`event: tool_status\ndata: ${JSON.stringify({ text: statusText })}\n\n`);
      },
      onMapUpdate: (data) => {
        res.write(`event: map_update\ndata: ${JSON.stringify(data)}\n\n`);
      }
    });

    res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  } catch (err: any) {
    const code = `${err?.message || 'ai_send_failed'}`;
    res.write(`event: error\ndata: ${JSON.stringify({ error: code })}\n\n`);
    res.end();
  }
});

app.get('/api/v1/notes', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const query = `${req.query.query || ''}`;
  const notes = listNotes(userId, limit, offset, query);
  const total = countNotes(userId, query);
  res.json({ notes, total, limit: Math.max(1, Math.min(50, limit || 20)), offset: Math.max(0, offset || 0) });
});

app.post('/api/v1/notes', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
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
  const userId = effectiveUserId(req);
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_note_id' });
  const ok = deleteNote(userId, noteId);
  if (!ok) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ ok: true });
});

app.get('/api/v1/notes/:id', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_note_id' });
  const note = getNoteById(userId, noteId);
  if (!note) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ note });
});

app.get('/api/v1/tasks', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const statusRaw = `${req.query.status || 'pending'}` as 'pending' | 'done' | 'error' | 'all';
  const status = ['pending', 'done', 'error', 'all'].includes(statusRaw) ? statusRaw : 'pending';
  const limit = Number.parseInt(`${req.query.limit || '50'}`, 10);
  const tasks = listTasks(userId, limit, status);
  res.json({ tasks });
});

app.post('/api/v1/tasks', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
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
  const userId = effectiveUserId(req);
  const taskId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId) || taskId <= 0) return res.status(400).json({ error: 'bad_task_id' });
  const ok = deletePendingTask(userId, taskId);
  if (!ok) return res.status(404).json({ error: 'task_not_found_or_not_pending' });
  return res.json({ ok: true });
});

// ── Map Pins (JWT) ─────────────────────────────────────────────────────────

app.get('/api/v1/map-pins', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const pins = listMapPins(userId);
  return res.json({ pins });
});

app.post('/api/v1/map-pins', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const lat = typeof req.body?.lat === 'number' ? req.body.lat : NaN;
  const lng = typeof req.body?.lng === 'number' ? req.body.lng : NaN;
  const label = `${req.body?.label || ''}`;
  const result = createMapPin(userId, lat, lng, label);
  if (result.ok === false) return res.status(400).json({ error: result.error });
  return res.status(201).json({ pin_id: result.id });
});

app.put('/api/v1/map-pins/:id', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const pinId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(pinId) || pinId <= 0) return res.status(400).json({ error: 'bad_pin_id' });
  const updates: { lat?: number; lng?: number; label?: string } = {};
  if (typeof req.body?.lat === 'number' && typeof req.body?.lng === 'number') {
    updates.lat = req.body.lat;
    updates.lng = req.body.lng;
  }
  if (typeof req.body?.label === 'string') updates.label = req.body.label;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
  const ok = updateMapPin(userId, pinId, updates);
  if (!ok) return res.status(404).json({ error: 'pin_not_found' });
  return res.json({ ok: true });
});

app.delete('/api/v1/map-pins/:id', (req: AuthedRequest, res) => {
  const userId = effectiveUserId(req);
  const pinId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(pinId) || pinId <= 0) return res.status(400).json({ error: 'bad_pin_id' });
  const ok = deleteMapPin(userId, pinId);
  if (!ok) return res.status(404).json({ error: 'pin_not_found' });
  return res.json({ ok: true });
});

// ── Telegram Link (JWT) ──────────────────────────────────────────────────

app.post('/api/v1/link/generate', authMiddleware, (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const result = generateLinkCode(userId);
  return res.json(result);
});

app.get('/api/v1/link/status', authMiddleware, (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  if (user.linked_tg_id) {
    const tgUser = getUserById(user.linked_tg_id);
    return res.json({ linked: true, tg_username: tgUser?.tg_username || tgUser?.name || null });
  }

  // Check if there's a pending code
  const pending = getLinkCodeForUser(userId);
  if (pending) {
    const expiresIn = Math.max(0, pending.expires_at - Math.floor(Date.now() / 1000));
    return res.json({ linked: false, pending_code: pending.code, expires_in: expiresIn });
  }

  return res.json({ linked: false });
});

app.post('/api/v1/link/unlink', authMiddleware, (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  if (!user.linked_tg_id) return res.status(400).json({ error: 'not_linked' });

  db.prepare('UPDATE users SET linked_tg_id = NULL WHERE id = ?').run(userId);

  // Reset plan back to free for the web user
  updateUserPlan(userId, 'free');

  return res.json({ ok: true });
});

// ── Prompts (public, for desktop) ──────────────────────────────────────

app.get('/api/v1/prompts', (req: AuthedRequest, res) => {
  const prompts = getAllPrompts();
  const user = getUserById(req.authUserId!);
  return res.json({
    prompts: prompts.map(p => ({ id: p.id, name: p.name, description: p.description, is_default: p.is_default })),
    selected_prompt_id: user?.selected_prompt_id ?? null,
    custom_prompt_content: user?.custom_prompt_content ?? null,
  });
});

app.post('/api/v1/prompts/select', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const promptId = Number(req.body?.prompt_id);
  if (!Number.isFinite(promptId)) return res.status(400).json({ error: 'bad_prompt_id' });

  if (promptId === -1) {
    selectUserCustomPrompt(userId);
  } else {
    const prompt = getPromptById(promptId);
    if (!prompt) return res.status(404).json({ error: 'prompt_not_found' });
    updateUserPrompt(userId, promptId);
  }
  return res.json({ ok: true });
});

app.put('/api/v1/prompts/custom', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const content = `${req.body?.content || ''}`;
  updateUserCustomPrompt(userId, content);
  return res.json({ ok: true });
});

// ── Internal: Telegram Link Verify (bot) ──────────────────────────────────

app.post('/internal/link/verify', internalAuth, (req, res) => {
  const code = `${req.body?.code || ''}`.trim();
  const tgId = Number(req.body?.tg_id);
  const tgUsername = `${req.body?.tg_username || ''}`.trim() || null;

  if (!code) return res.status(400).json({ error: 'code_required' });
  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'tg_id_required' });

  const tgUser = getUserById(tgId);
  if (!tgUser) return res.status(404).json({ error: 'telegram_user_not_found' });
  if (tgUser.status !== 'approved' && tgUser.is_admin !== 1) {
    return res.status(403).json({ error: 'telegram_user_not_approved', status: tgUser.status });
  }

  const result = verifyLinkCode(code);
  if (!result.ok) return res.status(404).json({ error: 'invalid_or_expired_code' });

  const webUserId = result.userId!;
  const webUser = getUserById(webUserId);
  if (!webUser) return res.status(404).json({ error: 'web_user_not_found' });

  // A Telegram account is the canonical identity. Move the link instead of
  // allowing several desktop accounts to consume one TG user's chats/limits.
  db.prepare('UPDATE users SET linked_tg_id = NULL WHERE linked_tg_id = ? AND id <> ?').run(tgId, webUserId);

  // Write linked_tg_id to the web user
  db.prepare('UPDATE users SET linked_tg_id = ? WHERE id = ?').run(tgId, webUserId);

  // Sync plan and limits from TG user to web user so the desktop client
  // sees updated feature flags (images, search, etc.) immediately.
  updateUserPlan(webUserId, tgUser.plan);

  return res.json({ ok: true, tg_id: tgId, tg_username: tgUsername });
});

app.post('/internal/link/unlink', internalAuth, (req, res) => {
  const tgId = Number(req.body?.tg_id);
  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'tg_id_required' });

  // Find web user linked to this TG account and clear the link
  const webUser = db.prepare('SELECT id FROM users WHERE linked_tg_id = ?').get(tgId) as { id: number } | undefined;
  if (!webUser) return res.status(404).json({ error: 'not_linked' });

  db.prepare('UPDATE users SET linked_tg_id = NULL WHERE id = ?').run(webUser.id);
  updateUserPlan(webUser.id, 'free');

  return res.json({ ok: true });
});

// ── Internal: Prompts CRUD ─────────────────────────────────────────────────

app.get('/internal/prompts', internalAuth, (_req, res) => {
  const prompts = getAllPrompts();
  return res.json({ prompts });
});

app.get('/internal/prompts/:id', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  const prompt = getPromptById(promptId);
  if (!prompt) return res.status(404).json({ error: 'prompt_not_found' });
  return res.json({ prompt });
});

app.post('/internal/prompts', internalAuth, (req, res) => {
  const name = `${req.body?.name || ''}`.trim();
  const description = `${req.body?.description || ''}`.trim();
  const content = `${req.body?.content || ''}`.trim();
  const isDefault = Boolean(req.body?.is_default);

  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!content) return res.status(400).json({ error: 'content_required' });

  try {
    const result = createPrompt(name, description, content, isDefault);
    return res.status(201).json({ ok: true, prompt_id: Number(result.lastInsertRowid) });
  } catch (err: any) {
    return res.status(409).json({ error: 'name_already_exists' });
  }
});

app.put('/internal/prompts/:id/name', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const name = `${req.body?.name || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  try {
    updatePromptName(promptId, name);
    return res.json({ ok: true });
  } catch {
    return res.status(409).json({ error: 'name_already_exists' });
  }
});

app.put('/internal/prompts/:id/description', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const description = `${req.body?.description || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  updatePromptDescription(promptId, description);
  return res.json({ ok: true });
});

app.put('/internal/prompts/:id/content', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const content = `${req.body?.content || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  if (!content) return res.status(400).json({ error: 'content_required' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  updatePromptContent(promptId, content);
  return res.json({ ok: true });
});

app.put('/internal/prompts/:id/default', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  setDefaultPrompt(promptId);
  return res.json({ ok: true });
});

app.delete('/internal/prompts/:id', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  const all = getAllPrompts();
  if (all.length <= 1) return res.status(422).json({ error: 'cannot_delete_last_prompt' });
  if (existing.is_default) return res.status(422).json({ error: 'cannot_delete_default_prompt' });

  deletePrompt(promptId);
  resetUsersPromptIfDeleted(promptId);
  return res.json({ ok: true });
});

// ── Internal: User prompt selection ────────────────────────────────────────

app.post('/internal/user/prompt/select', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const promptId = Number(req.body?.prompt_id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(promptId)) return res.status(400).json({ error: 'bad_prompt_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  if (promptId === -1) {
    selectUserCustomPrompt(userId);
  } else {
    const prompt = getPromptById(promptId);
    if (!prompt) return res.status(404).json({ error: 'prompt_not_found' });
    updateUserPrompt(userId, promptId);
  }
  return res.json({ ok: true });
});

app.put('/internal/user/prompt/custom', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const content = `${req.body?.content || ''}`;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserCustomPrompt(userId, content);
  return res.json({ ok: true });
});

// ── Internal: Timezone ────────────────────────────────────────────────────

app.post('/internal/user/timezone', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const offset = Number(req.body?.timezone_offset);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(offset) || offset < -12 || offset > 14) return res.status(400).json({ error: 'bad_timezone_offset' });

  setUserTimezone(userId, Math.floor(offset));
  return res.json({ ok: true });
});

// ── Internal: Context Window ──────────────────────────────────────────────

app.post('/internal/user/context-window', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const contextWindow = Number(req.body?.context_window);
  const isAdmin = Boolean(req.body?.is_admin);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return res.status(400).json({ error: 'bad_context_window' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  if (!isAdmin) {
    const maxWindow = Number.isFinite(user.context_window_max) && user.context_window_max > 0
      ? Math.floor(user.context_window_max) : 10;
    if (contextWindow > maxWindow) return res.status(422).json({ error: 'exceeds_max_context_window', max: maxWindow });
  }

  updateUserContextWindow(userId, Math.floor(contextWindow));
  return res.json({ ok: true });
});

// ── Internal: Mail Accounts Management ────────────────────────────────────

app.post('/internal/mail/setup', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const provider = normalizeMailProvider(req.body?.provider);
  const email = `${req.body?.email || ''}`.trim();
  const appPassword = `${req.body?.app_password || ''}`;

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!provider) return res.status(400).json({ error: 'bad_provider' });
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!appPassword) return res.status(400).json({ error: 'app_password_required' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  const config = resolveImapProviderConfig(provider);
  if (!config) return res.status(400).json({ error: 'bad_provider' });

  const encryptedPass = encryptSecret(appPassword);
  upsertMailAccount(userId, provider, email, encryptedPass, config.host, config.port, config.secure);
  setActiveMailProvider(userId, provider);
  updateUserMailSettings(userId, config.provider, email, encryptedPass, config.host, config.port, config.secure);

  const accounts = getMailAccountsForUser(userId);
  return res.json({ ok: true, accounts: accounts.map(a => ({ provider: a.provider, imap_user: a.imap_user })) });
});

app.post('/internal/mail/use', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const provider = normalizeMailProvider(req.body?.provider);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!provider) return res.status(400).json({ error: 'bad_provider' });

  const account = getMailAccountForUser(userId, provider);
  if (!account) return res.status(404).json({ error: 'mail_account_not_found' });

  setActiveMailProvider(userId, provider);
  updateUserMailSettings(userId, provider, account.imap_user, account.imap_pass, account.imap_host, account.imap_port, account.imap_secure);
  return res.json({ ok: true, provider, imap_user: account.imap_user });
});

app.put('/internal/mail/limit', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const limit = Number(req.body?.limit);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(limit) || limit <= 0) return res.status(400).json({ error: 'bad_limit' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserMailCheckLimit(userId, Math.floor(limit));
  return res.json({ ok: true, limit: Math.floor(limit) });
});

app.delete('/internal/mail/account', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id);
  const provider = normalizeMailProvider(req.body?.provider);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  if (!provider) {
    clearUserMailSettings(userId);
    deleteAllMailAccounts(userId);
    return res.json({ ok: true, deleted: 'all' });
  }

  deleteMailAccount(userId, provider);
  const remaining = getMailAccountsForUser(userId);
  if (!remaining.length) {
    clearUserMailSettings(userId);
    return res.json({ ok: true, deleted: provider, remaining: [] });
  }

  const nextActive = remaining[0];
  setActiveMailProvider(userId, nextActive.provider);
  updateUserMailSettings(userId, nextActive.provider, nextActive.imap_user, nextActive.imap_pass, nextActive.imap_host, nextActive.imap_port, nextActive.imap_secure);
  return res.json({ ok: true, deleted: provider, new_active: { provider: nextActive.provider, imap_user: nextActive.imap_user } });
});

// ── Internal: Daily Reset ─────────────────────────────────────────────────

app.post('/internal/daily-reset', internalAuth, (_req, res) => {
  resetDailyMessageCounters();
  return res.json({ ok: true });
});

// ── Internal: User management for bot ──────────────────────────────────────

app.post('/internal/users/upsert-telegram', internalAuth, (req, res) => {
  const tgId = Number(req.body?.tg_id);
  const name = `${req.body?.name || ''}`.trim();
  const role = `${req.body?.role || 'user'}`.trim();
  const status = `${req.body?.status || 'none'}` as 'none' | 'approved' | 'disapproved' | 'banned';
  const tgUsername = req.body?.tg_username ?? null;
  const defaultPromptId = req.body?.default_prompt_id ?? null;

  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'bad_tg_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  upsertTelegramUser(tgId, name, role, status, tgUsername, defaultPromptId);
  const user = getUserById(tgId);
  return res.json({ ok: true, user });
});

app.post('/internal/users/create-pending', internalAuth, (req, res) => {
  const tgId = Number(req.body?.tg_id);
  const name = req.body?.name ?? null;
  const tgUsername = req.body?.tg_username ?? null;
  const defaultPromptId = req.body?.default_prompt_id ?? null;

  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'bad_tg_id' });

  createPendingTelegramUser(tgId, name, tgUsername, defaultPromptId);
  const user = getUserById(tgId);
  return res.json({ ok: true, user });
});

app.get('/internal/users/:id', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ user });
});

app.put('/internal/users/:id/tg-username', internalAuth, (req, res) => {
  const userId = Number(req.body?.user_id || req.params.id);
  const tgUsername = req.body?.tg_username ?? null;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  updateUserTelegramUsername(userId, tgUsername);
  return res.json({ ok: true });
});

// ── Internal: User listing ────────────────────────────────────────────────

app.get('/internal/users', internalAuth, (req, res) => {
  const filter = `${req.query?.filter || 'all'}`.trim().toLowerCase();
  const limit = Number.parseInt(`${req.query?.limit || 50}`, 10);
  const offset = Number.parseInt(`${req.query?.offset || 0}`, 10);

  if (filter === 'pending') {
    const count = getPendingUsersCount();
    const users = getPendingUsersPage(limit, offset);
    return res.json({ users, total: count, filter, limit, offset });
  }

  if (filter === 'banned') {
    const count = getBannedUsersCount();
    const users = getBannedUsersPage(limit, offset);
    return res.json({ users, total: count, filter, limit, offset });
  }

  const count = getUsersCount();
  const users = getUsersPage(limit, offset);
  return res.json({ users, total: count, filter: 'all', limit, offset });
});

// ── Internal: User status/role/name management ────────────────────────────

app.put('/internal/users/:id/status', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const status = `${req.body?.status || ''}`.trim() as 'none' | 'approved' | 'disapproved' | 'banned';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['none', 'approved', 'disapproved', 'banned'].includes(status)) return res.status(400).json({ error: 'bad_status' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserStatus(userId, status);
  return res.json({ ok: true, status });
});

app.put('/internal/users/:id/role', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const role = `${req.body?.role || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserRole(userId, role);
  return res.json({ ok: true, role });
});

app.put('/internal/users/:id/name', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const name = `${req.body?.name || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserName(userId, name);
  return res.json({ ok: true, name });
});

app.delete('/internal/users/:id', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  if (ADMIN_IDS.has(userId)) return res.status(422).json({ error: 'cannot_delete_admin_from_env' });

  removeUser(userId);
  return res.json({ ok: true });
});

// ── Internal: User plan management ────────────────────────────────────────

app.post('/internal/users/:id/plan', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const plan = `${req.body?.plan || ''}`.trim() as 'free' | 'standart' | 'pro';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['free', 'standart', 'pro'].includes(plan)) return res.status(400).json({ error: 'bad_plan' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserPlan(userId, plan);
  return res.json({ ok: true, plan });
});

app.post('/internal/sync-plan-limits', internalAuth, (_req, res) => {
  syncAllUsersPlanLimits();
  return res.json({ ok: true });
});

// ── Internal: Ban management ──────────────────────────────────────────────

app.post('/internal/users/:id/ban', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const reason = `${req.body?.reason || ''}`.trim() || 'Решение администратора';
  const bannedBy = Number(req.body?.banned_by) || 0;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (ADMIN_IDS.has(userId)) return res.status(422).json({ error: 'cannot_ban_admin_from_env' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  setBan(userId, bannedBy, reason);
  updateUserStatus(userId, 'banned');
  return res.json({ ok: true, reason });
});

app.delete('/internal/users/:id/ban', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  removeBan(userId);
  updateUserStatus(userId, 'none');
  return res.json({ ok: true, status: 'none' });
});

app.get('/internal/users/:id/ban', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const ban = getBanRecord(userId);
  return res.json({ ban: ban || null });
});

// ── Internal: User prompt management (for index.ts) ───────────────────────

app.post('/internal/users/:id/prompt/select', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const promptId = Number(req.body?.prompt_id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(promptId)) return res.status(400).json({ error: 'bad_prompt_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  if (promptId === -1) {
    selectUserCustomPrompt(userId);
  } else {
    const prompt = getPromptById(promptId);
    if (!prompt) return res.status(404).json({ error: 'prompt_not_found' });
    updateUserPrompt(userId, promptId);
  }
  return res.json({ ok: true });
});

app.put('/internal/users/:id/prompt/custom', internalAuth, (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const content = `${req.body?.content || ''}`;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserCustomPrompt(userId, content);
  return res.json({ ok: true });
});

app.post('/internal/prompts/reset-users', internalAuth, (req, res) => {
  const promptId = Number(req.body?.prompt_id);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  resetUsersPromptIfDeleted(promptId);
  return res.json({ ok: true });
});

// ── Admin JWT: User management ────────────────────────────────────────────

app.get('/api/v1/admin/users', adminMiddleware, (req: AuthedRequest, res) => {
  const filter = `${req.query?.filter || 'all'}`.trim().toLowerCase();
  const limit = Number.parseInt(`${req.query?.limit || 50}`, 10);
  const offset = Number.parseInt(`${req.query?.offset || 0}`, 10);

  if (filter === 'pending') {
    const count = getPendingUsersCount();
    const users = getPendingUsersPage(limit, offset);
    return res.json({ users, total: count, filter, limit, offset });
  }

  if (filter === 'banned') {
    const count = getBannedUsersCount();
    const users = getBannedUsersPage(limit, offset);
    return res.json({ users, total: count, filter, limit, offset });
  }

  const count = getUsersCount();
  const users = getUsersPage(limit, offset);
  return res.json({ users, total: count, filter: 'all', limit, offset });
});

app.get('/api/v1/admin/users/:id', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  let ban = null;
  if (user.status === 'banned') {
    ban = getBanRecord(userId) || null;
  }

  return res.json({ user, ban });
});

app.put('/api/v1/admin/users/:id/status', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const status = `${req.body?.status || ''}`.trim() as 'none' | 'approved' | 'disapproved' | 'banned';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['none', 'approved', 'disapproved', 'banned'].includes(status)) return res.status(400).json({ error: 'bad_status' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserStatus(userId, status);
  return res.json({ ok: true, status });
});

app.put('/api/v1/admin/users/:id/role', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const role = `${req.body?.role || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserRole(userId, role);
  return res.json({ ok: true, role });
});

app.put('/api/v1/admin/users/:id/name', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const name = `${req.body?.name || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserName(userId, name);
  return res.json({ ok: true, name });
});

app.delete('/api/v1/admin/users/:id', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  // Prevent deleting ADMIN_IDS users
  if (ADMIN_IDS.has(userId)) return res.status(422).json({ error: 'cannot_delete_admin_from_env' });

  removeUser(userId);
  return res.json({ ok: true });
});

app.post('/api/v1/admin/users/:id/plan', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const plan = `${req.body?.plan || ''}`.trim() as 'free' | 'standart' | 'pro';
  const duration = `${req.body?.duration || 'forever'}`.trim();

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['free', 'standart', 'pro'].includes(plan)) return res.status(400).json({ error: 'bad_plan' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  // Close current subscription
  db.prepare('UPDATE user_plan_subscriptions SET is_current = 0 WHERE user_id = ? AND is_current = 1').run(userId);

  // Calculate end date
  let endsAt: string | null = null;
  if (duration !== 'forever') {
    const now = new Date();
    switch (duration) {
      case 'day': now.setDate(now.getDate() + 1); break;
      case 'week': now.setDate(now.getDate() + 7); break;
      case 'month': now.setMonth(now.getMonth() + 1); break;
      case 'year': now.setFullYear(now.getFullYear() + 1); break;
      default: break;
    }
    if (['day', 'week', 'month', 'year'].includes(duration)) {
      endsAt = now.toISOString();
    }
  }

  // Create new subscription
  db.prepare(`
    INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current, assigned_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1, ?)
  `).run(userId, plan, endsAt, req.authUserId!);

  updateUserPlan(userId, plan);
  return res.json({ ok: true, plan, ends_at: endsAt });
});

app.post('/api/v1/admin/users/:id/ban', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const reason = `${req.body?.reason || ''}`.trim() || 'Решение администратора';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (ADMIN_IDS.has(userId)) return res.status(422).json({ error: 'cannot_ban_admin_from_env' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  setBan(userId, req.authUserId!, reason);
  updateUserStatus(userId, 'banned');
  return res.json({ ok: true, reason });
});

app.delete('/api/v1/admin/users/:id/ban', adminMiddleware, (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  removeBan(userId);
  updateUserStatus(userId, 'none');
  return res.json({ ok: true, status: 'none' });
});

app.post('/api/v1/admin/sync-plan-limits', adminMiddleware, (_req: AuthedRequest, res) => {
  syncAllUsersPlanLimits();
  return res.json({ ok: true });
});

// ─── Macros CRUD ────────────────────────────────────────────────────────────

app.get('/api/v1/macros', (req: AuthedRequest, res: any) => {
  const userId = effectiveUserId(req);
  return res.json({ macros: listMacros(userId) });
});

app.post('/api/v1/macros', (req: AuthedRequest, res: any) => {
  const userId = effectiveUserId(req);
  const title = `${req.body?.title || ''}`.trim();
  const description = `${req.body?.description || ''}`.trim();
  const commands: unknown = req.body?.commands;
  const enabled = req.body?.enabled !== false;
  const pinned = req.body?.pinned === true;
  const return_output = req.body?.return_output === true;

  if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string')) {
    return res.status(400).json({ error: 'commands_required' });
  }

  const result = createMacro(userId, title, description, commands, enabled, pinned, return_output);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'title_required' || code === 'commands_required') return res.status(400).json({ error: code });
    if (code === 'macros_limit') return res.status(429).json({ error: code });
    return res.status(422).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.put('/api/v1/macros/:id', (req: AuthedRequest, res: any) => {
  const userId = effectiveUserId(req);
  const macroId = Number(req.params.id);
  if (!Number.isFinite(macroId)) return res.status(400).json({ error: 'invalid_id' });

  const updates: Record<string, unknown> = {};
  if (req.body?.title !== undefined) updates.title = `${req.body.title}`.trim();
  if (req.body?.description !== undefined) updates.description = `${req.body.description}`.trim();
  if (Array.isArray(req.body?.commands)) updates.commands = req.body.commands;
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.pinned !== undefined) updates.pinned = Boolean(req.body.pinned);
  if (req.body?.return_output !== undefined) updates.return_output = Boolean(req.body.return_output);

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  const result = updateMacro(userId, macroId, updates);
  if (!result.ok) {
    const err = (result as { ok: false; error: string }).error;
    if (err === 'not_found') return res.status(404).json({ error: err });
    return res.status(422).json({ error: err });
  }
  return res.json({ ok: true });
});

app.delete('/api/v1/macros/:id', (req: AuthedRequest, res: any) => {
  const userId = effectiveUserId(req);
  const macroId = Number(req.params.id);
  if (!Number.isFinite(macroId)) return res.status(400).json({ error: 'invalid_id' });

  const deleted = deleteMacro(userId, macroId);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

// ─── Macro helpers (lightweight AI, no DB) ────────────────────────────────────

app.post('/api/v1/macro/explain', async (req: AuthedRequest, res) => {
  const commands: unknown = req.body?.commands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.some(c => typeof c !== 'string')) {
    return res.status(400).json({ error: 'commands_required_array_of_strings' });
  }

  try {
    const text = await callLiteAi(
      'Ты — системный администратор. Кратко (2-4 предложения) объясни, что делает этот набор команд в консоли Windows/Linux. Отвечай на русском, без лишних вводных слов.',
      commands.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')
    );
    return res.json({ explanation: text });
  } catch (err) {
    console.error('[macro/explain]', err);
    return res.status(500).json({ error: 'ai_call_failed' });
  }
});

app.post('/api/v1/macro/describe', async (req: AuthedRequest, res) => {
  const commands: unknown = req.body?.commands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.some(c => typeof c !== 'string')) {
    return res.status(400).json({ error: 'commands_required_array_of_strings' });
  }

  const currentTitle = typeof req.body?.current_title === 'string' ? req.body.current_title : '';
  const currentDescription = typeof req.body?.current_description === 'string' ? req.body.current_description : '';

  try {
    const commandList = commands.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n');
    const currentInfo = currentTitle || currentDescription
      ? `\n\nТекущее название: "${currentTitle}"\nТекущее описание: "${currentDescription}"\nУлучши их — сделай более точными и ёмкими, но сохрани смысл если он верный.`
      : '';

    const raw = await callLiteAi(
      'Ты — системный администратор. Придумай короткое, ёмкое название (до 5 слов) и описание (1-2 предложения) для этого скрипта. Ответь СТРОГО JSON-объектом: { "title": "...", "description": "..." }. Без markdown, без пояснений, только JSON.',
      `${commandList}${currentInfo}`
    );

    // Try to extract JSON from the response (AI might wrap it in ```json ... ```)
    let parsed: { title?: string; description?: string };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: '', description: '' };
    } catch {
      parsed = { title: '', description: raw };
    }

    return res.json({
      title: parsed.title || '',
      description: parsed.description || ''
    });
  } catch (err) {
    console.error('[macro/describe]', err);
    return res.status(500).json({ error: 'ai_call_failed' });
  }
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, () => {
  console.log(`[backend-api] started on :${PORT}`);
  if (BACKEND_VOICE_API_ENABLED) {
    console.log('[backend-voice] enabled (BACKEND_VOICE_API_ENABLED=1), endpoint: POST /internal/voice/turn');
  } else {
    console.log('[backend-voice] disabled (BACKEND_VOICE_API_ENABLED != 1)');
  }
  if (BACKEND_PHOTO_API_ENABLED) {
    console.log('[backend-photo] enabled (BACKEND_PHOTO_API_ENABLED=1), endpoint: POST /internal/photo/analyze');
  } else {
    console.log('[backend-photo] disabled (BACKEND_PHOTO_API_ENABLED != 1)');
  }
  if (BACKEND_VECTOR_MEMORY_API_ENABLED) {
    console.log('[backend-vector-memory] enabled (BACKEND_VECTOR_MEMORY_API_ENABLED=1), endpoints: POST /api/v1/vector-memory/chunks, POST /api/v1/vector-memory/search');
  } else {
    console.log('[backend-vector-memory] disabled (BACKEND_VECTOR_MEMORY_API_ENABLED != 1)');
  }
  startTaskScheduler();
});

// Increase timeout for long-running AI requests (tool loops, streaming)
server.timeout = 5 * 60 * 1000;       // 5 minutes
server.keepAliveTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000 + 1000;

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log(`[WS] New connection! URL: ${req.url}, host: ${req.headers.host}`);

  // 1. Authenticate via query param
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  if (!token) { console.log('[WS] REJECTED: no token'); ws.close(4001, 'no_token'); return; }

  const payload = verifyToken(token, 'access');
  if (!payload) { console.log('[WS] REJECTED: invalid token'); ws.close(4001, 'invalid_token'); return; }

  const apiUserId = payload.sub;
  console.log(`[WS] Token valid, apiUserId=${apiUserId}`);

  // Resolve effective user (linked TG account)
  const rawUser = getUserById(apiUserId);
  const effectiveUserId = rawUser?.linked_tg_id || apiUserId;
  console.log(`[WS] rawUser linked_tg_id=${rawUser?.linked_tg_id}, effectiveUserId=${effectiveUserId}`);

  // 2. Kick existing connection for this user
  const existing = wsClients.get(apiUserId);
  if (existing) {
    existing.ws.removeAllListeners();
    existing.ws.close(4002, 'replaced');
  }

  // 3. Register client (under both apiUserId and effectiveUserId)
  const client: WsClient = { ws, apiUserId, effectiveUserId, pendingIpc: new Map() };
  registerWsClient(client);
  console.log(`[ws] user ${apiUserId} (effective: ${effectiveUserId}) connected, total: ${wsClients.size}`);

  // 4. Handle incoming messages
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'chat_send') {
        await handleWsChatSend(client, msg);
      } else if (msg.type === 'ipc_result') {
        handleIpcResult(client, msg);
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.error('[ws] message error:', err);
    }
  });

  ws.on('close', () => {
    unregisterWsClient(client);
    // Reject all pending IPC requests
    for (const [, pending] of client.pendingIpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ws_disconnected'));
    }
    console.log(`[ws] user ${apiUserId} (effective: ${effectiveUserId}) disconnected, total: ${wsClients.size}`);
  });
});

// ── WS chat_send handler ────────────────────────────────────────────────────

async function handleWsChatSend(client: WsClient, msg: any) {
  const { text, chat_id, images, display_manifest, is_voice } = msg;
  if (!text?.trim()) {
    client.ws.send(JSON.stringify({ type: 'error', error: 'empty_text' }));
    return;
  }

  // Resolve effective user (linked TG account)
  const userId = client.effectiveUserId;
  const apiUserId = client.apiUserId;

  // Parse & validate images
  const MAX_IMAGE_BYTES_API = 20 * 1024 * 1024;
  const imagesRaw: Array<any> = Array.isArray(images) ? images : [];
  const parsedImages = imagesRaw
    .map((img: any) => ({
      base64: `${img?.base64 || ''}`.trim(),
      mimeType: `${img?.mime_type || 'image/jpeg'}`.trim() || 'image/jpeg',
    }))
    .filter(img => img.base64.length > 0);

  for (const img of parsedImages) {
    const buf = Buffer.from(img.base64, 'base64');
    if (!buf.length) continue;
    if (buf.length > MAX_IMAGE_BYTES_API) {
      client.ws.send(JSON.stringify({ type: 'error', error: 'image_too_large' }));
      return;
    }
  }

  // Save thumbnails for user images
  let savedUserImages: Array<{ url: string; type: 'user_photo' }> | null = null;
  if (parsedImages.length > 0) {
    try {
      const { saveUserImageThumbnail } = await import('./services/image-storage.js');
      const saved: Array<{ url: string; type: 'user_photo' }> = [];
      for (const img of parsedImages) {
        const result = await saveUserImageThumbnail(img.base64, img.mimeType);
        saved.push({ url: result.url, type: 'user_photo' });
      }
      savedUserImages = saved;
    } catch (err) {
      console.error('[ws] failed to save image thumbnails:', err);
    }
  }

  const enabledMacros = getEnabledMacros(userId);

  try {
    const result = await sendMessageThroughAi(userId, text, chat_id, {
      ...(parsedImages.length > 0 ? { images: parsedImages } : {}),
      userImages: savedUserImages,
      displayManifest: display_manifest,
      isDesktop: true,
      isVoice: Boolean(is_voice),
      activeMacros: enabledMacros,
      ...(apiUserId !== userId ? { promptUserId: apiUserId } : {}),
      onIntermediateMessage: (stepText) => {
        client.ws.send(JSON.stringify({ type: 'intermediate', text: stepText }));
      },
      onStateChange: (state) => {
        client.ws.send(JSON.stringify({ type: 'display_state', ...state }));
      },
      onDesktopAction: (action) => {
        client.ws.send(JSON.stringify({ type: 'desktop_action', ...action }));
      },
      onToolStatus: (statusText) => {
        client.ws.send(JSON.stringify({ type: 'tool_status', text: statusText }));
      },
      onMapUpdate: (data) => {
        client.ws.send(JSON.stringify({ type: 'map_update', ...data }));
      },
    });

    client.ws.send(JSON.stringify({ type: 'done', ...result }));
  } catch (err: any) {
    const code = `${err?.message || 'ai_send_failed'}`;
    client.ws.send(JSON.stringify({ type: 'error', error: code }));
  }
}

// ── WS ipc_result handler ────────────────────────────────────────────────────

function handleIpcResult(client: WsClient, msg: any) {
  const { request_id, data, error } = msg;
  const pending = client.pendingIpc.get(request_id);
  if (!pending) return;

  clearTimeout(pending.timer);
  client.pendingIpc.delete(request_id);

  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(data);
  }
}
