import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
import { getEncryptionKey } from './utils/encryption.js';

import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { wsClients, registerWsClient, unregisterWsClient, isDesktopOnline, sendToDesktop, WS_HEARTBEAT_GRACE_MS, WS_HEARTBEAT_INTERVAL_MS, type WsClient } from './ws-clients.js';
import { adminMiddleware, authMiddleware, issueAuthTokens, makePasswordHash, refreshAccessToken, validateTelegramInitData, verifyPassword, verifyToken, verifyTokenIgnoreExpiry, type AuthedRequest } from './auth.js';
import { activateUserChat, bindChatMessageTelegramMeta, clearAllUserMessages, clearUserChatMessages, createPasswordAccount, createOrUpdateUserForApiRegistration, createUserChat, deleteUserHistoryByRole, deleteUserHistoryMessage, ensureActiveChat, forkChat, getPasswordAccountByLogin, getChatMessages, getChatMedia, getAllUserMedia, getRecentUserHistory, getUserById, getUserChatById, listUserChats, upsertUserFromTelegram, setUserTimezone, updateUserPrompt, selectUserCustomPrompt, updateUserCustomPrompt, resetUsersPromptIfDeleted, resetDailyMessageCounters, upsertTelegramUser, createPendingTelegramUser, updateUserStatus, updateUserRole, updateUserName, updateUserTelegramUsername, removeUser, getAllUsers, getUsersCount, getUsersPage, getPendingUsersCount, getPendingUsersPage, getBannedUsersCount, getBannedUsersPage, updateUserPlan, syncAllUsersPlanLimits, resetUserWeeklyUsage, resetAllUsersWeeklyUsage, updateUserWeeklyCostQuota, revokeUserAuthTokens, generateLinkCode, verifyLinkCode, getLinkCodeForUser, generatePasswordResetCode, verifyPasswordResetCode, signPasswordResetToken, verifyPasswordResetToken, adminApplyGeneratedPassword, renameUserChat, deleteUserChat, deleteUserMessage, editUserMessage, searchUserChats, updateChatMessageAudio, getChatMessageOwner, getChatContextTokens, resolveMaxContextTokens, updateUserMaxContextTokens, getChatAttachments, deleteMessageAttachment, deleteMessageImage, resolveAttachmentMaxTokens, updateUserAttachmentMaxTokens, setChatBotHidden } from './services/chats.js';
import { createNote, countNotes, deleteNote, getNoteById, getNoteStats, getNoteStatsForUsers, listNotes, updateNoteContent } from './services/notes.js';
import { createTask, deletePendingTask, getUserTaskById, listTasks } from './services/tasks.js';
import { listMapPins, getMapPinById, createMapPin, updateMapPin, deleteMapPin } from './services/map-pins.js';
import { sendMessageThroughAi, generateAdminOutreach, callLiteAi, getModelsCatalog, getAutoReasoningLevels, getAutoVisionSupport, activeGenerations, getUpdateState, setUpdatePrepare, forceAbortActiveGenerations, clearUpdatePrepare, resolveManualModel } from './services/ai.js';
import { initSubagentRunner } from './services/subagents/runner.js';
import { runCompletion, runTool, throwIfAborted, withAbort, toolDefinitions, normalizeTokenUsage } from './services/ai.js';
import { listMacros, getMacroById, getEnabledMacros, createMacro, updateMacro, deleteMacro } from './services/macros.js';
import { listServers, getServerById, createServer, updateServer, deleteServer, listPolicies, createPolicy, deletePolicy, isAutoApproved, serverHasSudoPassword, listRunbooks, getRunbookById, createRunbook, updateRunbook, deleteRunbook, attachRunbookToServer, listSshKeys, createSshKey, deleteSshKey, buildInstallKeyScript, getSshPublicKey, listPublicRunbooks, getPublicRunbookById, createPublicRunbook, updatePublicRunbook, deletePublicRunbook } from './services/devops.js';
import { execSshCommand, testSshConnection } from './services/ssh.js';
import { getPendingConfirmation, deletePendingConfirmation } from './services/devops-confirmations.js';
import { getPcCommandsSettings, updatePcCommandsSettings, listPcCommandPolicies, createPcCommandPolicy, deletePcCommandPolicy } from './services/pc-commands.js';
import { getPendingPcConfirmation, deletePendingPcConfirmation } from './services/pc-command-confirmations.js';
import { getPendingVisualClick, deletePendingVisualClick } from './services/visual-click-confirmations.js';
import { getPendingEmailConfirmation, deletePendingEmailConfirmation } from './services/email-confirmations.js';
import { runImageGeneration } from './services/image-generation.js';
import { getSmartHomeSettings, setSmartHomeToken, deleteSmartHomeToken, setZigbeeToken, deleteZigbeeToken, listSmartDevices, syncSmartHomeDevices } from './services/smart-home.js';
import { db } from './db.js';
import { getCleanTextFromUrl } from './services/web-reader.js';
import { startTaskScheduler } from './services/scheduler.js';
import { runVoiceTurn } from './services/voice.js';
import { runPhotoAnalyzeTurn } from './services/photo.js';
import { migratePendingAccountNamespaces, VectorMemoryService } from './services/vector-memory.js';
import { seedPlanLimitsIfEmpty, loadPlanLimitsFromDb, savePlanLimitsToDb, DEFAULT_PLAN_LIMITS, PLAN_IDS, type PlanLimits } from './services/plan-limits.js';
import { refreshCoefficientCache, setCoefficient, setModelProvider, getModelOverride, getOverrideMap } from './services/token-quota.js';
import type { ProviderKind, PricingMode, ModelOverride } from './services/token-quota.js';
import { sendTelegramMessage } from './services/telegram-send.js';
import { getAllPrompts, getPromptById, createPrompt, updatePromptName, updatePromptDescription, updatePromptContent, setDefaultPrompt, deletePrompt, ensureDefaultPrompt, resolvePromptForUser as resolveStoredPromptForUser, getUserPrompts, getUserPromptById, createUserPrompt, updateUserPrompt as updateUserPromptRow, deleteUserPrompt as deleteUserPromptRow, toUserPromptSelectedId, parseUserPromptRowId, USER_PROMPT_OFFSET } from './services/prompts.js';
import { upsertMailAccount, setActiveMailAccount, deleteMailAccount, clearUserMailSettings, deleteAllMailAccounts, getMailAccountsForUser, getMailAccountById, resolveMailAccountReference, normalizeMailProvider, encryptSecret, runEmailSend, verifyMailAccountConnection } from './services/mail.js';
import type { MailProvider } from './services/mail.js';
import { setBan, removeBan, getBanRecord } from './services/bans.js';
import {
  areImageAttachmentsAllowedForPlan,
  MAX_IMAGE_ATTACHMENTS_PER_REQUEST,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
} from './services/plan-limits.js';
import { resolveImageFile, getUploadsDir } from './services/image-storage.js';
import { resolveAttachmentFile, MAX_RAW_FILE_SIZE as MAX_ATTACHMENT_BYTES } from './services/attachment-storage.js';
import { parseDocument, guessMimeType, SUPPORTED_EXTENSIONS } from './services/document-parser.js';
import { resolveAudioFile, saveTtsAudio } from './services/audio-storage.js';
import { isCartesiaConfigured, fetchCartesiaVoices, generateTtsAudio } from './services/tts-cartesia.js';
import type { UserRecord } from './types.js';
import {
  getAccountIdByTelegramId,
  getAccountIdentities,
  getTelegramIdentityForAccount,
  linkAccountToTelegram,
  resolveAccountId,
  unlinkTelegramFromAccount,
} from './services/accounts.js';
import { normalizeSupportedLanguage, SUPPORTED_LANGUAGES } from './i18n/languages.js';
import { translateForLanguage } from './i18n/index.js';
import { associateServerAccessKeyUser, createServerAccessKey, getLastServerAccessKeyForUser, isServerAccessKeyGateEnabled, listServerAccessKeys, revokeServerAccessKey, validateServerAccessKey } from './services/server-access-keys.js';

dotenv.config();
ensureDefaultPrompt();
db.transaction(() => {
  for (const user of getAllUsers()) {
    const activeChatId = ensureActiveChat(user.id);
    db.prepare('UPDATE chat_messages SET chat_id = ? WHERE user_id = ? AND chat_id IS NULL')
      .run(activeChatId, user.id);
    const currentSubscription = db.prepare('SELECT id FROM user_plan_subscriptions WHERE user_id = ? AND is_current = 1 LIMIT 1')
      .get(user.id) as { id: number } | undefined;
    if (!currentSubscription) {
      db.prepare(`
        INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current, assigned_by)
        VALUES (?, ?, CURRENT_TIMESTAMP, NULL, 1, NULL)
      `).run(user.id, user.plan);
    }
  }
})();

const formatSafeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Build a localized error payload for AI send failures (quota, etc.). */
const buildLocalizedAiError = (err: any, userId: number): { error: string; message?: string } => {
  const code = `${err?.message || 'ai_send_failed'}`;
  if (code === 'quota_exceeded') {
    const user = getUserById(userId);
    const resetsAt = err?.resetsAt
      ? new Date(err.resetsAt * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const message = translateForLanguage(user?.language, 'errors.quotaExceeded', { resetsAt });
    return { error: code, message };
  }
  if (code === 'server_update_in_progress') {
    const user = getUserById(userId);
    const message = translateForLanguage(user?.language, 'errors.serverUpdating');
    return { error: code, message };
  }
  const user = getUserById(userId);
  const message = translateForLanguage(user?.language, 'errors.genericServerError');
  return { error: code, message };
};


type ModerationNotification = 'approved' | 'rejected' | 'banned' | 'unbanned';

const notifyUserMessengers = async (
  userId: number,
  notification: ModerationNotification,
  values: Record<string, string | number> = {},
) => {
  const user = getUserById(userId);
  if (!user) return;

  const text = translateForLanguage(user.language, `moderationNotifications.${notification}`, values);
  const messengerIdentities = getAccountIdentities(userId)
    .filter(identity => identity.provider !== 'password');

  for (const identity of messengerIdentities) {
    try {
      if (identity.provider === 'telegram') {
        const telegramId = Number(identity.provider_subject);
        if (Number.isFinite(telegramId) && telegramId > 0) {
          await sendTelegramMessage(telegramId, text, { strict: true, preferRich: false });
        }
      }
    } catch (error) {
      console.warn(`[moderation] failed to notify ${identity.provider} identity for account ${userId}:`, formatSafeError(error));
    }
  }
};

const queueUserMessengerNotification = (
  userId: number,
  notification: ModerationNotification,
  values: Record<string, string | number> = {},
) => {
  void notifyUserMessengers(userId, notification, values).catch(error => {
    console.warn(`[moderation] notification job failed for account ${userId}:`, formatSafeError(error));
  });
};

const app = express();
const PORT = Number.parseInt(process.env.BACKEND_API_PORT || '3050', 10) || 3050;
const BACKEND_INTERNAL_TOKEN = `${process.env.BACKEND_INTERNAL_TOKEN || ''}`.trim();

app.use(express.json({ limit: '64mb' }));

const buildRejectedByUserError = (commentRaw: unknown) => {
  const comment = typeof commentRaw === 'string' ? commentRaw.trim().slice(0, 1000) : '';
  return new Error(comment ? `rejected_by_user:${comment}` : 'rejected_by_user');
};

// CORS
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Chatter-Server-Key');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Images are served via /api/v1/images/:filename (auth + ownership check) ─
const uploadsDir = getUploadsDir();
console.log(`[uploads] directory: ${uploadsDir}`);

// Legacy redirect: /uploads/:filename → /api/v1/images/:filename (preserves old URLs in DB)
app.get('/uploads/:filename', (req: any, res: any) => {
  const query = req.query.token ? `?token=${req.query.token}` : '';
  res.redirect(301, `/api/v1/images/${req.params.filename}${query}`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'backend-api', now: Math.floor(Date.now() / 1000) });
});

app.get('/api/v1/server-access/validate', (req, res) => {
  const accessKey = validateServerAccessKey(`${req.headers['x-chatter-server-key'] || ''}`);
  if (!accessKey) return res.status(403).json({ error: 'invalid_server_access_key' });
  return res.json({ ok: true, key: { id: accessKey.id, name: accessKey.name } });
});

const internalAuth = (req: any, res: any, next: any) => {
  if (!BACKEND_INTERNAL_TOKEN) return res.status(503).json({ error: 'internal_token_not_configured' });
  const authHeader = `${req.headers.authorization || ''}`;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token !== BACKEND_INTERNAL_TOKEN) return res.status(401).json({ error: 'unauthorized_internal' });
  next();
};

const serverAccessKeyForPasswordAuth = (req: any, res: any) => {
  if (!isServerAccessKeyGateEnabled()) return null;
  const accessKey = validateServerAccessKey(`${req.headers['x-chatter-server-key'] || ''}`);
  if (!accessKey) {
    res.status(403).json({ error: 'server_access_key_required' });
    return false;
  }
  return accessKey;
};

// Internal API contracts use canonical account IDs exclusively. Telegram IDs
// are resolved only by explicitly Telegram-scoped endpoints.
const resolveInternalAccountId = (rawAccountId: unknown): number => {
  const accountId = Math.floor(Number(rawAccountId));
  if (!Number.isFinite(accountId) || accountId <= 0) return Number.NaN;
  return resolveAccountId(accountId);
};

const internalAdminAuth = (req: any, res: any, next: any) => {
  const actorId = resolveInternalAccountId(req.body?.actor_user_id ?? req.query?.actor_user_id);
  if (!Number.isFinite(actorId) || actorId <= 0) return res.status(400).json({ error: 'actor_user_id_required' });
  const actor = getUserById(actorId);
  if (!actor || actor.status !== 'approved' || (actor.role !== 'admin' && actor.is_admin !== 1)) {
    return res.status(403).json({ error: 'admin_required' });
  }
  req.internalActorId = actorId;
  next();
};

const BACKEND_VOICE_API_ENABLED = `${process.env.BACKEND_VOICE_API_ENABLED || '0'}`.trim() === '1';
const BACKEND_VECTOR_MEMORY_API_ENABLED = `${process.env.BACKEND_VECTOR_MEMORY_API_ENABLED || '0'}`.trim() === '1';

// Telegram chat UI. The bot supplies Telegram IDs; backend-api resolves the
// canonical account and remains the only process mutating chat tables.
app.get('/internal/users/:id/chats', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  const activeChatId = ensureActiveChat(userId);
  return res.json({ chats: listUserChats(userId, limit, offset), active_chat_id: activeChatId });
});

app.get('/internal/users/:id/chats/:chatId', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const chat = getUserChatById(userId, chatId);
  if (!chat) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ chat, is_active: ensureActiveChat(userId) === chatId });
});

app.post('/internal/users/:id/chats', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const title = `${req.body?.title || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });
  const chatId = createUserChat(userId, title);
  const chat = getUserChatById(userId, chatId);
  return res.status(201).json({ ok: true, chat });
});

app.post('/internal/users/:id/chats/:chatId/activate', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  if (!activateUserChat(userId, chatId)) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true, chat: getUserChatById(userId, chatId) });
});

app.delete('/internal/users/:id/chats/:chatId/messages', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  if (!clearUserChatMessages(userId, chatId)) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true });
});

app.delete('/internal/users/:id/messages', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ ok: true, deleted: clearAllUserMessages(userId) });
});

app.get('/internal/admin/users/:id/history', internalAuth, internalAdminAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const limit = Number(req.query.limit ?? 20);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ messages: getRecentUserHistory(userId, limit) });
});

app.delete('/internal/admin/users/:id/history', internalAuth, internalAdminAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });

  const role = `${req.body?.role || ''}` as 'user' | 'assistant' | 'all' | '';
  if (role === 'user' || role === 'assistant' || role === 'all') {
    return res.json({ ok: true, deleted: deleteUserHistoryByRole(userId, role), matched_by: role });
  }

  const messageId = Math.floor(Number(req.body?.message_id));
  const mode = req.body?.mode === 'tg' ? 'tg' : 'db';
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });
  return res.json({ ok: true, deleted: deleteUserHistoryMessage(userId, messageId, mode), matched_by: mode });
});

app.get('/internal/users/:id/notes', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const limit = Number(req.query.limit ?? 20);
  const offset = Number(req.query.offset ?? 0);
  const query = `${req.query.query || ''}`;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ notes: listNotes(userId, limit, offset, query), total: countNotes(userId, query) });
});

app.get('/internal/users/:id/notes/:noteId', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const noteId = Number.parseInt(req.params.noteId, 10);
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_id' });
  const note = getNoteById(userId, noteId);
  if (!note) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ note });
});

app.post('/internal/users/:id/notes', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const result = createNote(userId, `${req.body?.title || ''}`, `${req.body?.content || ''}`);
  if (!result.ok) return res.status(422).json(result);
  return res.status(201).json(result);
});

app.put('/internal/users/:id/notes/:noteId', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const noteId = Number.parseInt(req.params.noteId, 10);
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const result = updateNoteContent(userId, noteId, `${req.body?.content || ''}`);
  if (!result.ok) return res.status(result.error === 'note_not_found' ? 404 : 422).json(result);
  return res.json(result);
});

app.delete('/internal/users/:id/notes/:noteId', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const noteId = Number.parseInt(req.params.noteId, 10);
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_id' });
  const deleted = deleteNote(userId, noteId);
  return deleted ? res.json({ ok: true }) : res.status(404).json({ error: 'note_not_found' });
});

app.get('/internal/users/:id/note-stats', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  return res.json({ stats: getNoteStats(userId) });
});

app.post('/internal/admin/notes/stats', internalAuth, internalAdminAuth, (req, res) => {
  const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map((value: unknown) => Number(value)) : [];
  return res.json({ stats: getNoteStatsForUsers(userIds) });
});

app.get('/internal/users/:id/tasks', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const limit = Number(req.query.limit ?? 20);
  const rawStatus = `${req.query.status || 'pending'}`;
  const status = ['pending', 'done', 'error', 'all'].includes(rawStatus)
    ? rawStatus as 'pending' | 'done' | 'error' | 'all'
    : 'pending';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!getUserById(userId)) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ tasks: listTasks(userId, limit, status) });
});

app.get('/internal/users/:id/tasks/:taskId', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const taskId = Number.parseInt(req.params.taskId, 10);
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(taskId) || taskId <= 0) return res.status(400).json({ error: 'bad_id' });
  const task = getUserTaskById(userId, taskId);
  return task ? res.json({ task }) : res.status(404).json({ error: 'task_not_found' });
});

app.delete('/internal/users/:id/tasks/:taskId', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const taskId = Number.parseInt(req.params.taskId, 10);
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(taskId) || taskId <= 0) return res.status(400).json({ error: 'bad_id' });
  return deletePendingTask(userId, taskId)
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'pending_task_not_found' });
});

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
  const userId = resolveInternalAccountId(req.body?.user_id);
  const text = `${req.body?.text || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;
  const optionsRaw = req.body?.options || {};
  const options = {
    forcePro: Boolean(optionsRaw.forcePro),
    countAsUserMessage: optionsRaw.countAsUserMessage === false ? false : true,
    skipHistory: Boolean(optionsRaw.skipHistory),
    persistUserText: typeof optionsRaw.persistUserText === 'string' ? optionsRaw.persistUserText : undefined,
    userTelegramChatId: Number.isFinite(Number(optionsRaw.userTelegramChatId)) ? Math.floor(Number(optionsRaw.userTelegramChatId)) : null,
    userTelegramMessageId: Number.isFinite(Number(optionsRaw.userTelegramMessageId)) ? Math.floor(Number(optionsRaw.userTelegramMessageId)) : null,
    assistantTelegramChatId: Number.isFinite(Number(optionsRaw.assistantTelegramChatId)) ? Math.floor(Number(optionsRaw.assistantTelegramChatId)) : null,
    preferredModel: typeof optionsRaw.preferredModel === 'string' ? optionsRaw.preferredModel : undefined,
  };

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!text.trim()) return res.status(400).json({ error: 'empty_text' });

  // Parse optional documents array (attachments) — mirrors /api/v1/chat/send
  const documentsRawInternal: Array<any> = Array.isArray(req.body?.documents) ? req.body.documents : [];
  let savedUserAttachmentsInternal: any[] | null = null;
  if (documentsRawInternal.length > 0) {
    try {
      const { saveUserDocument } = await import('./services/attachment-storage.js');
      const saved: any[] = [];
      for (const doc of documentsRawInternal) {
        const base64 = `${doc?.base64 || ''}`.trim();
        const filename = `${doc?.filename || 'document'}`.trim();
        if (!base64) continue;
        const buf = Buffer.from(base64, 'base64');
        if (!buf.length) continue;
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return res.status(413).json({ error: 'document_too_large', filename });
        }
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          return res.status(400).json({ error: 'unsupported_document_format', filename, ext });
        }
        const extractedText = await parseDocument(buf, filename);
        const stored = await saveUserDocument(buf, filename);
        saved.push({
          name: filename,
          size_bytes: buf.length,
          mime_type: guessMimeType(filename),
          extracted_text: extractedText,
          url: stored.url,
          filename: stored.filename,
        });
      }
      savedUserAttachmentsInternal = saved.length > 0 ? saved : null;
    } catch (err: any) {
      console.error('[internal/ai/send] failed to save documents:', formatSafeError(err));
      return res.status(400).json({ error: 'document_parse_failed', detail: err?.message || String(err) });
    }
  }

  try {
    const enabledMacros = getEnabledMacros(userId);
    const tgUser = getUserById(Math.floor(userId));
    const result = await sendMessageThroughAi(Math.floor(userId), text, chatId, {
      ...options,
      activeMacros: enabledMacros,
      featureFlags: tgUser ? parseFeatureFlags(tgUser) : undefined,
      diceRollMode: tgUser ? Boolean(parseUiSettings(tgUser).dice_roll_enabled) : false,
      ...(savedUserAttachmentsInternal ? { userAttachments: savedUserAttachmentsInternal } : {}),
    });

    // If AI triggered a desktop_action and desktop is online — push via WS
    console.log(`[TG→WS] result.desktop_action=${JSON.stringify(result.desktop_action)}, isDesktopOnline=${isDesktopOnline(userId)}`);
    if (result.desktop_action && isDesktopOnline(userId)) {
      const client = wsClients.get(userId);
      const payload = JSON.stringify({ type: 'desktop_action', ...result.desktop_action });
      console.log(`[TG→WS] PUSHING to user ${userId}: ${payload}`);
      client!.ws.send(payload);
    } else {
      console.log(`[TG→WS] SKIPPED: desktop_action=${!!result.desktop_action}, online=${isDesktopOnline(userId)}`);
    }

    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'ai_send_failed'}`;
    if (code === 'user_not_approved') return res.status(403).json({ error: code });
    if (code === 'empty_text') return res.status(400).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    const payload = buildLocalizedAiError(err, userId);
    return res.status(500).json(payload);
  }
});

// ── Internal: AI Send (SSE streaming for Telegram) ──────────────────────────

app.post('/internal/ai/stream', internalAuth, async (req: any, res: any) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const text = `${req.body?.text || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;
  const optionsRaw = req.body?.options || {};
  const options = {
    forcePro: Boolean(optionsRaw.forcePro),
    countAsUserMessage: optionsRaw.countAsUserMessage === false ? false : true,
    skipHistory: Boolean(optionsRaw.skipHistory),
    persistUserText: typeof optionsRaw.persistUserText === 'string' ? optionsRaw.persistUserText : undefined,
    userTelegramChatId: Number.isFinite(Number(optionsRaw.userTelegramChatId)) ? Math.floor(Number(optionsRaw.userTelegramChatId)) : null,
    userTelegramMessageId: Number.isFinite(Number(optionsRaw.userTelegramMessageId)) ? Math.floor(Number(optionsRaw.userTelegramMessageId)) : null,
    assistantTelegramChatId: Number.isFinite(Number(optionsRaw.assistantTelegramChatId)) ? Math.floor(Number(optionsRaw.assistantTelegramChatId)) : null,
    preferredModel: typeof optionsRaw.preferredModel === 'string' ? optionsRaw.preferredModel : undefined,
  };

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!text.trim()) return res.status(400).json({ error: 'empty_text' });

  // Parse optional documents array (attachments) — mirrors /api/v1/chat/send
  const documentsRawStream: Array<any> = Array.isArray(req.body?.documents) ? req.body.documents : [];
  let savedUserAttachmentsStream: any[] | null = null;
  if (documentsRawStream.length > 0) {
    try {
      const { saveUserDocument } = await import('./services/attachment-storage.js');
      const saved: any[] = [];
      for (const doc of documentsRawStream) {
        const base64 = `${doc?.base64 || ''}`.trim();
        const filename = `${doc?.filename || 'document'}`.trim();
        if (!base64) continue;
        const buf = Buffer.from(base64, 'base64');
        if (!buf.length) continue;
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return res.status(413).json({ error: 'document_too_large', filename });
        }
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          return res.status(400).json({ error: 'unsupported_document_format', filename, ext });
        }
        const extractedText = await parseDocument(buf, filename);
        const stored = await saveUserDocument(buf, filename);
        saved.push({
          name: filename,
          size_bytes: buf.length,
          mime_type: guessMimeType(filename),
          extracted_text: extractedText,
          url: stored.url,
          filename: stored.filename,
        });
      }
      savedUserAttachmentsStream = saved.length > 0 ? saved : null;
    } catch (err: any) {
      console.error('[internal/ai/stream] failed to save documents:', formatSafeError(err));
      return res.status(400).json({ error: 'document_parse_failed', detail: err?.message || String(err) });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');

  try {
    const enabledMacros = getEnabledMacros(userId);
    const tgUser = getUserById(Math.floor(userId));
    const result = await sendMessageThroughAi(Math.floor(userId), text, chatId, {
      ...options,
      activeMacros: enabledMacros,
      featureFlags: tgUser ? parseFeatureFlags(tgUser) : undefined,
      diceRollMode: tgUser ? Boolean(parseUiSettings(tgUser).dice_roll_enabled) : false,
      ...(savedUserAttachmentsStream ? { userAttachments: savedUserAttachmentsStream } : {}),
      onIntermediateMessage: (stepText) => {
        res.write(`event: intermediate\ndata: ${JSON.stringify({ text: stepText })}\n\n`);
      },
      onToolStatus: (statusText) => {
        res.write(`event: tool_status\ndata: ${JSON.stringify({ text: statusText })}\n\n`);
      },
      onDesktopAction: (action) => {
        // Forward ALL desktop_actions (including pc_command_confirmation) to TG via SSE
        res.write(`event: desktop_action\ndata: ${JSON.stringify(action)}\n\n`);
      },
      onStateChange: (state) => {
        res.write(`event: display_state\ndata: ${JSON.stringify(state)}\n\n`);
      },
      onMapUpdate: (data) => {
        sendToDesktop(userId, { type: 'map_update', ...data });
      },
      onDiceRoll: (roll) => {
        res.write(`event: dice_roll\ndata: ${JSON.stringify({ roll })}\n\n`);
      },
      onStreamToken: (text) => {
        res.write(`event: stream_token\ndata: ${JSON.stringify({ text })}\n\n`);
      },
      onReasoningStream: (text) => {
        res.write(`event: reasoning_token\ndata: ${JSON.stringify({ text })}\n\n`);
      },
    });

    // Push desktop_action via WS if desktop is also connected (TG→Desktop push pattern)
    if (result.desktop_action && isDesktopOnline(userId)) {
      const client = wsClients.get(userId);
      if (client) {
        client.ws.send(JSON.stringify({ type: 'desktop_action', ...result.desktop_action }));
      }
    }

    res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  } catch (err: any) {
    const payload = buildLocalizedAiError(err, userId);
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
  }
});



app.post('/internal/ai/admin-outreach', internalAuth, async (req, res) => {
  const targetUserId = resolveInternalAccountId(req.body?.target_user_id);
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

// ── Internal: Models ─────────────────────────────────────────────────────────

app.get('/internal/models', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.query?.user_id);
  const user = Number.isFinite(userId) && userId > 0 ? getUserById(userId) : undefined;
  const catalog = getModelsCatalog(user?.is_admin === 1);
  return res.json({ models: catalog });
});

app.get('/internal/users/:id/preferred-model', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const catalog = getModelsCatalog(user.is_admin === 1);
  return res.json({ models: catalog, preferred_model: user.preferred_model || null });
});

app.put('/internal/users/:id/preferred-model', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const modelId = req.body?.model_id ?? null;
  if (modelId !== null && typeof modelId !== 'string') return res.status(400).json({ error: 'bad_model_id' });
  if (modelId !== null) {
    const catalog = getModelsCatalog(user.is_admin === 1);
    if (!catalog.some(m => m.id === modelId)) return res.status(400).json({ error: 'model_not_found' });
  }
  db.prepare('UPDATE users SET preferred_model = ? WHERE id = ?').run(modelId, userId);
  return res.json({ ok: true, preferred_model: modelId });
});

app.post('/internal/reset-daily-counters', internalAuth, (_req, res) => {
  resetDailyMessageCounters();
  return res.json({ ok: true });
});

app.post('/internal/ai/generate-image', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
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
  const userId = resolveInternalAccountId(req.body?.user_id);
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

  const userId = resolveInternalAccountId(req.body?.user_id);
  const audioBase64 = `${req.body?.audio_base64 || ''}`;
  const mimeType = `${req.body?.mime_type || 'audio/ogg'}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;
  const transcriptionLanguage = `${req.body?.language || ''}`.trim() || null;
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
        assistantTelegramChatId: Number.isFinite(Number(optionsRaw.assistantTelegramChatId)) ? Math.floor(Number(optionsRaw.assistantTelegramChatId)) : null,
        transcriptionLanguage
      }
    );
    return res.json(result);
  } catch (err: any) {
    const code = `${err?.message || 'voice_turn_failed'}`;
    if (code === 'user_not_approved') return res.status(403).json({ error: code });
    if (code === 'empty_audio') return res.status(400).json({ error: code });
    if (code === 'audio_too_large') return res.status(413).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.post('/internal/photo/analyze', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
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
    if (code === 'empty_image') return res.status(400).json({ error: code });
    if (code === 'image_too_large') return res.status(413).json({ error: code });
    if (code === 'image_payload_too_large') return res.status(413).json({ error: code });
    if (code === 'user_not_found') return res.status(404).json({ error: code });
    if (code.startsWith('too_many_images')) return res.status(400).json({ error: code });
    if (code === 'images_not_allowed_for_plan') return res.status(403).json({ error: code });
    return res.status(500).json({ error: code });
  }
});

app.post('/api/v1/auth/register', (req, res) => {
  const serverAccessKey = serverAccessKeyForPasswordAuth(req, res);
  if (serverAccessKey === false) return;
  const login = `${req.body?.login || ''}`.trim().toLowerCase();
  const password = `${req.body?.password || ''}`;
  const name = `${req.body?.name || ''}`.trim() || null;

  if (!/^[-_.a-z0-9]{3,64}$/i.test(login)) return res.status(400).json({ error: 'bad_login' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'bad_password_length' });

  if (getPasswordAccountByLogin(login)) return res.status(409).json({ error: 'login_already_exists' });

  const hashed = makePasswordHash(password);
  const userId = db.transaction(() => {
    const createdUserId = createOrUpdateUserForApiRegistration(name);
    createPasswordAccount(createdUserId, login, hashed.salt, hashed.hash);
    return createdUserId;
  })();

  const user = getUserById(userId);
  if (!user) return res.status(500).json({ error: 'user_create_failed' });

  if (serverAccessKey) associateServerAccessKeyUser(serverAccessKey.id, userId);
  const tokens = issueAuthTokens(userId, serverAccessKey?.id);
  return res.status(201).json({
    ...tokens,
    user: toAuthUserDto(user)
  });
});

const parseFeatureFlags = (user: UserRecord): Record<string, boolean> => {
  try {
    return JSON.parse(user.feature_flags || '{}');
  } catch { return {}; }
};

/** UI settings: configurable display options stored per-user. */
export const parseUiSettings = (user: UserRecord): {
  show_tokens?: boolean;
  dice_roll_enabled?: boolean;
  seen_announcements?: string[];
} => {
  try {
    const parsed = JSON.parse(user.ui_settings || '{}');
    return {
      ...(typeof parsed.show_tokens === 'boolean' ? { show_tokens: parsed.show_tokens } : {}),
      ...(typeof parsed.dice_roll_enabled === 'boolean' ? { dice_roll_enabled: parsed.dice_roll_enabled } : {}),
      ...(Array.isArray(parsed.seen_announcements) && parsed.seen_announcements.every((id: unknown) => typeof id === 'string')
        ? { seen_announcements: parsed.seen_announcements as string[] }
        : {}),
    };
  } catch { return {}; }
};

const toAuthUserDto = (user: UserRecord) => {
  const accountId = resolveAccountId(user.id);
  const effectiveUser = getUserById(accountId) || user;
  const identities = getAccountIdentities(accountId);
  const telegramIdentity = identities.find(identity => identity.provider === 'telegram');

  return {
    id: accountId,
    name: effectiveUser.name,
    username: telegramIdentity?.username ?? null,
    role: effectiveUser.role,
    is_admin: effectiveUser.is_admin,
    plan: effectiveUser.plan,
    image_attachments_allowed: areImageAttachmentsAllowedForPlan(effectiveUser.plan, effectiveUser.is_admin === 1),
    max_image_attachments_per_request: MAX_IMAGE_ATTACHMENTS_PER_REQUEST,
    max_image_attachments_total_bytes: MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
    selected_prompt_id: effectiveUser.selected_prompt_id ?? null,
    custom_prompt_content: effectiveUser.custom_prompt_content ?? null,
    core_memory: effectiveUser.core_memory ?? null,
    language: normalizeSupportedLanguage(effectiveUser.language),
    ui_settings: parseUiSettings(effectiveUser),
    subagent_model: effectiveUser.subagent_mode && effectiveUser.subagent_mode !== 'auto' ? effectiveUser.subagent_mode : null,
    subagent_reasoning_level: effectiveUser.subagent_reasoning_level ?? null,
    telegram_linked: Boolean(telegramIdentity),
    telegram_id: telegramIdentity ? Number(telegramIdentity.provider_subject) : null,
    must_change_password: Number(effectiveUser.must_change_password || 0) === 1,
    identities: identities.map(identity => ({
      provider: identity.provider,
      provider_subject: identity.provider_subject,
      username: identity.username,
    })),
  };
};

app.post('/api/v1/auth/login', (req, res) => {
  const serverAccessKey = serverAccessKeyForPasswordAuth(req, res);
  if (serverAccessKey === false) return;
  const login = `${req.body?.login || ''}`.trim().toLowerCase();
  const password = `${req.body?.password || ''}`;

  if (!login || !password) return res.status(400).json({ error: 'login_password_required' });
  const account = getPasswordAccountByLogin(login);
  if (!account) return res.status(401).json({ error: 'invalid_credentials' });
  if (!verifyPassword(password, account.password_salt, account.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const user = getUserById(account.user_id);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  if (user.status !== 'approved' && user.is_admin !== 1) {
    return res.status(403).json({ error: 'access_not_approved', status: user.status });
  }

  if (serverAccessKey) associateServerAccessKeyUser(serverAccessKey.id, user.id);
  const tokens = issueAuthTokens(user.id, serverAccessKey?.id);
  return res.json({
    ...tokens,
    user: toAuthUserDto(user)
  });
});

app.post('/api/v1/auth/telegram', (req, res) => {
  const initData = `${req.body?.initData || ''}`.trim();
  if (!initData) return res.status(400).json({ error: 'initData_required' });

  const validated = validateTelegramInitData(initData);
  if (!validated.ok) return res.status(401).json({ error: 'invalid_init_data', reason: validated.reason });

  const user = validated.user;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;
  upsertUserFromTelegram(user.id, user.username || null, fullName, user.language_code || null);

  const accountId = getAccountIdByTelegramId(user.id);
  if (!accountId) return res.status(500).json({ error: 'telegram_identity_create_failed' });
  const userRecord = getUserById(accountId);
  if (!userRecord) return res.status(500).json({ error: 'user_create_failed' });
  if (userRecord.status !== 'approved' && userRecord.is_admin !== 1) {
    return res.status(403).json({ error: 'access_not_approved', status: userRecord.status });
  }

  const tokens = issueAuthTokens(accountId);
  return res.json({
    ...tokens,
    user: toAuthUserDto(userRecord)
  });
});

app.post('/api/v1/auth/refresh', (req, res) => {
  const refresh = `${req.body?.refresh_token || ''}`.trim();
  if (!refresh) return res.status(400).json({ error: 'refresh_token_required' });
  const tokens = refreshAccessToken(refresh);
  if (!tokens) return res.status(401).json({ error: 'invalid_refresh_token' });
  return res.json(tokens);
});

// ── Image download API (owner-only, supports ?token= query param for <img src>) ─
// Optional ?w=N query param resizes on-the-fly for gallery thumbnails.
app.get('/api/v1/images/:filename', async (req: AuthedRequest, res) => {
  // Accept token from query param (for <img src> usage) or Authorization header
  const queryToken = `${req.query.token || ''}`.trim();
  const authHeader = `${req.headers.authorization || ''}`;
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = queryToken || headerToken;

  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const payload = verifyToken(token, 'access');
  if (!payload) return res.status(401).json({ error: 'unauthorized' });

  const userId = payload.sub;

  const effectiveId = resolveAccountId(userId);
  const filename = path.basename(req.params.filename || '');
  if (!filename) return res.status(400).json({ error: 'bad_filename' });

  const filepath = resolveImageFile(filename);
  if (!filepath) return res.status(404).json({ error: 'image_not_found' });

  // Verify ownership: check that this image belongs to a message owned by this user
  // images column may be JSON: [{"url":"/api/v1/images/xxx.png",...}] or plain text: "generated: /uploads/xxx.png"
  const likePattern = `%${filename}%`;
  console.log(`[image-access] userId=${userId}, effectiveId=${effectiveId}, filename=${filename}`);
  const row = db.prepare(`
    SELECT 1 FROM chat_messages
    WHERE user_id = ? AND images LIKE ?
    LIMIT 1
  `).get(effectiveId, likePattern) as { 1: number } | undefined;

  if (!row) {
    console.log(`[image-access] DENIED - no matching row for effectiveId=${effectiveId}, pattern=${likePattern}`);
    return res.status(403).json({ error: 'access_denied' });
  }

  // On-the-fly resize for gallery thumbnails
  const targetWidth = Number.parseInt(`${req.query.w || ''}`, 10);
  if (targetWidth > 0 && targetWidth <= 1920) {
    try {
      const sharp = (await import('sharp')).default;
      const resized = await sharp(filepath, { failOn: 'none' })
        .resize(targetWidth, targetWidth, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.send(resized);
      return;
    } catch (err) {
      console.error(`[image-resize] Failed to resize ${filename}:`, err);
      // fall through to send original file
    }
  }

  res.sendFile(filepath);
});

// ── Attachment (document) download API (owner-only, supports ?token= query param) ─
app.get('/api/v1/attachments/:filename', (req: AuthedRequest, res) => {
  const queryToken = `${req.query.token || ''}`.trim();
  const authHeader = `${req.headers.authorization || ''}`;
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = queryToken || headerToken;

  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const payload = verifyToken(token, 'access');
  if (!payload) return res.status(401).json({ error: 'unauthorized' });

  const userId = payload.sub;
  const effectiveId = resolveAccountId(userId);
  const filename = path.basename(req.params.filename || '');
  if (!filename) return res.status(400).json({ error: 'bad_filename' });

  const filepath = resolveAttachmentFile(filename);
  if (!filepath) return res.status(404).json({ error: 'attachment_not_found' });

  // Verify ownership: check that this attachment belongs to a message owned by this user
  const likePattern = `%${filename}%`;
  const row = db.prepare(`
    SELECT 1 FROM chat_messages
    WHERE user_id = ? AND attachments LIKE ?
    LIMIT 1
  `).get(effectiveId, likePattern) as { 1: number } | undefined;

  if (!row) {
    return res.status(403).json({ error: 'access_denied' });
  }

  res.sendFile(filepath);
});

// ── Audio download API (owner-only, supports ?token= query param for <audio src>) ─
app.get('/api/v1/audio/:filename', (req: AuthedRequest, res) => {
  const queryToken = `${req.query.token || ''}`.trim();
  const authHeader = `${req.headers.authorization || ''}`;
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = queryToken || headerToken;

  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const payload = verifyToken(token, 'access');
  if (!payload) return res.status(401).json({ error: 'unauthorized' });

  const userId = payload.sub;
  const effectiveId = resolveAccountId(userId);
  const filename = path.basename(req.params.filename || '');
  if (!filename) return res.status(400).json({ error: 'bad_filename' });

  const filepath = resolveAudioFile(filename);
  if (!filepath) return res.status(404).json({ error: 'audio_not_found' });

  // Verify access: check chat_messages (per-user audio) OR tts_voice_previews (shared preview cache)
  const likePattern = `%${filename}%`;
  const msgRow = db.prepare(`
    SELECT 1 FROM chat_messages
    WHERE user_id = ? AND audio LIKE ?
    LIMIT 1
  `).get(effectiveId, likePattern) as { 1: number } | undefined;

  const previewRow = db.prepare(`
    SELECT 1 FROM tts_voice_previews
    WHERE audio_url LIKE ?
    LIMIT 1
  `).get(likePattern) as { 1: number } | undefined;

  if (!msgRow && !previewRow) return res.status(403).json({ error: 'access_denied' });

  res.sendFile(filepath);
});

app.use('/api/v1', authMiddleware);

// Return current authenticated user profile
app.get('/api/v1/auth/me', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ user: toAuthUserDto(user) });
});

app.get('/api/v1/user/language', (req: AuthedRequest, res) => {
  const userId = resolveAccountId(req.authUserId!);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ language: normalizeSupportedLanguage(user.language) });
});

app.put('/api/v1/user/language', (req: AuthedRequest, res) => {
  const language = normalizeSupportedLanguage(req.body?.language);
  if (!language) {
    return res.status(400).json({
      error: 'unsupported_language',
      supported_languages: SUPPORTED_LANGUAGES,
    });
  }

  const userId = resolveAccountId(req.authUserId!);
  const result = db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
  if (result.changes === 0) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ ok: true, language });
});

app.put('/api/v1/user/name', (req: AuthedRequest, res) => {
  const name = `${req.body?.name || ''}`.trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  const userId = resolveAccountId(req.authUserId!);
  const result = db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
  if (result.changes === 0) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ ok: true, name });
});

// Revoke every access/refresh token previously issued to this account.
app.post('/api/v1/auth/logout', (req: AuthedRequest, res) => {
  revokeUserAuthTokens(req.authUserId!);
  return res.json({ ok: true, all_sessions_revoked: true });
});

// ── Password recovery ────────────────────────────────────────────────────

// Step 1: Request password reset code. Sends a 6-digit code via Telegram.
app.post('/api/v1/auth/forgot-password', (req, res) => {
  const login = `${req.body?.login || ''}`.trim().toLowerCase();
  if (!login) return res.status(400).json({ error: 'login_required' });

  const account = getPasswordAccountByLogin(login);
  // Never reveal if the login exists — same response for both cases
  if (!account) return res.json({ ok: true });

  const accountId = resolveAccountId(account.user_id);
  const user = getUserById(accountId);
  if (!user || (user.status !== 'approved' && user.is_admin !== 1)) return res.json({ ok: true });

  // Check if Telegram is linked — silently skip if not (no enumeration)
  const identities = getAccountIdentities(accountId);
  const telegramIdentity = identities.find(i => i.provider === 'telegram');
  if (!telegramIdentity) return res.json({ ok: true });

  const telegramId = Number(telegramIdentity.provider_subject);
  if (!Number.isFinite(telegramId) || telegramId <= 0) return res.json({ ok: true });

  // Generate code (with rate limit)
  const result = generatePasswordResetCode(accountId);
  if ('error' in result) {
    if (result.error === 'too_many_requests') {
      return res.status(429).json({ error: 'too_many_requests', retry_after: result.retry_after });
    }
    return res.status(500).json({ error: 'code_generation_failed' });
  }

  // Send code via Telegram — use account's preferred language if set.
  // Compose title (bold) + body, both localized. The code is wrapped in
  // backticks for monospace rendering in Telegram. Markdown is preserved
  // by sendTelegramMessage when the message is sent through Bot API.
  const recoveryTitle = translateForLanguage(user.language, 'passwordReset.title');
  const recoveryBody = translateForLanguage(user.language, 'passwordReset.body', { code: `\`${result.code}\`` });
  const recoveryMessage = `*${recoveryTitle}*\n\n${recoveryBody}`;
  sendTelegramMessage(
    telegramId,
    recoveryMessage,
    { strict: false }
  ).catch(err => console.warn('[forgot-password] Failed to send Telegram message:', err));

  return res.json({ ok: true, method: 'telegram' });
});

// Step 2: Verify the 6-digit code. Returns a signed reset_token for password change.
app.post('/api/v1/auth/verify-reset-code', (req, res) => {
  const login = `${req.body?.login || ''}`.trim().toLowerCase();
  const code = `${req.body?.code || ''}`.trim();

  if (!login) return res.status(400).json({ error: 'login_required' });
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'code_required' });
  }

  const account = getPasswordAccountByLogin(login);
  if (!account) return res.status(404).json({ error: 'account_not_found' });

  const accountId = resolveAccountId(account.user_id);
  const verification = verifyPasswordResetCode(accountId, code);

  if (!verification.ok) {
    if (verification.error === 'expired') return res.status(410).json({ error: 'code_expired' });
    if (verification.error === 'too_many_attempts') return res.status(429).json({ error: 'too_many_attempts' });
    if (verification.error === 'wrong_code') {
      return res.status(400).json({ error: 'wrong_code', attempts_left: verification.attempts_left });
    }
    return res.status(404).json({ error: 'code_not_found' });
  }

  // Issue a temporary reset token (only usable for password change)
  const resetToken = signPasswordResetToken(accountId);
  return res.json({ ok: true, reset_token: resetToken });
});

// Step 3: Set a new password using the reset_token.
app.post('/api/v1/auth/reset-password', (req, res) => {
  const resetToken = `${req.body?.reset_token || ''}`.trim();
  const newPassword = `${req.body?.new_password || ''}`;

  if (!resetToken) return res.status(400).json({ error: 'reset_token_required' });
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'bad_password_length' });
  }

  const accountId = verifyPasswordResetToken(resetToken);
  if (!accountId) return res.status(401).json({ error: 'invalid_or_expired_reset_token' });

  const identities = getAccountIdentities(accountId);
  const passwordIdentity = identities.find(i => i.provider === 'password');
  if (!passwordIdentity) return res.status(404).json({ error: 'password_identity_not_found' });

  const { salt, hash: newHash } = makePasswordHash(newPassword);
  db.prepare('UPDATE account_identities SET password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(salt, newHash, passwordIdentity.id);

  // Clear the "must change password" flag — user just chose a new password.
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(accountId);

  // Revoke all existing tokens
  revokeUserAuthTokens(accountId);

  return res.json({ ok: true });
});

// ── Password / login change (authenticated) ──────────────────────────────

// Change password while logged in.
app.put('/api/v1/user/password', (req: AuthedRequest, res) => {
  const userId = resolveAccountId(req.authUserId!);
  const currentPassword = `${req.body?.current_password || ''}`;
  const newPassword = `${req.body?.new_password || ''}`;

  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'password_required' });
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'bad_password_length' });
  }

  const identities = getAccountIdentities(userId);
  const passwordIdentity = identities.find(i => i.provider === 'password');
  if (!passwordIdentity || !passwordIdentity.password_salt || !passwordIdentity.password_hash) {
    return res.status(400).json({ error: 'no_password_identity' });
  }

  if (!verifyPassword(currentPassword, passwordIdentity.password_salt, passwordIdentity.password_hash)) {
    return res.status(401).json({ error: 'wrong_current_password' });
  }

  const { salt, hash: newHash } = makePasswordHash(newPassword);
  db.prepare('UPDATE account_identities SET password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(salt, newHash, passwordIdentity.id);

  // Clear the "must change password" flag — user successfully changed password.
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(userId);

  revokeUserAuthTokens(userId);
  return res.json({ ok: true });
});

// Change login while logged in.
app.put('/api/v1/user/login', (req: AuthedRequest, res) => {
  const userId = resolveAccountId(req.authUserId!);
  const password = `${req.body?.password || ''}`;
  const newLogin = `${req.body?.new_login || ''}`.trim().toLowerCase();

  if (!password || !newLogin) return res.status(400).json({ error: 'login_password_required' });
  if (!/^[-_.a-z0-9]{3,64}$/i.test(newLogin)) return res.status(400).json({ error: 'bad_login' });

  const identities = getAccountIdentities(userId);
  const passwordIdentity = identities.find(i => i.provider === 'password');
  if (!passwordIdentity || !passwordIdentity.password_salt || !passwordIdentity.password_hash) {
    return res.status(400).json({ error: 'no_password_identity' });
  }

  if (!verifyPassword(password, passwordIdentity.password_salt, passwordIdentity.password_hash)) {
    return res.status(401).json({ error: 'wrong_current_password' });
  }

  // Check if new login is already taken
  if (getPasswordAccountByLogin(newLogin)) {
    return res.status(409).json({ error: 'login_already_exists' });
  }

  db.prepare('UPDATE account_identities SET provider_subject = ?, username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newLogin, newLogin, passwordIdentity.id);

  revokeUserAuthTokens(userId);
  return res.json({ ok: true, login: newLogin });
});

// Update core memory
app.put('/api/v1/account/core-memory', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const content = typeof req.body?.content === 'string' ? req.body.content.slice(0, 800) : '';
  db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(content, userId);
  return res.json({ ok: true });
});

// Weekly quota / budget usage for the current user
app.get('/api/v1/account/quota', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const row = db.prepare(`
    SELECT weekly_tokens_used, weekly_tokens_quota, weekly_window_started_at,
           weekly_cost_used, weekly_cost_quota
    FROM users WHERE id = ?
  `).get(userId) as {
    weekly_tokens_used: number;
    weekly_tokens_quota: number;
    weekly_window_started_at: number;
    weekly_cost_used: number;
    weekly_cost_quota: number;
  } | undefined;
  if (!row) return res.status(404).json({ error: 'user_not_found' });

  const userPlan = getUserById(userId)?.plan;
  const planLimitsMap = loadPlanLimitsFromDb();
  const planLimits = planLimitsMap[userPlan as keyof typeof planLimitsMap] ?? planLimitsMap.free;
  const isBudget = planLimits.billing_mode === 'budget';
  const used = isBudget ? row.weekly_cost_used : row.weekly_tokens_used;
  const quota = isBudget ? row.weekly_cost_quota : row.weekly_tokens_quota;
  const percent = quota > 0 ? Math.min(100, Math.round((Number(used) || 0) / quota * 100)) : 0;

  const WEEK_SECONDS = 7 * 24 * 60 * 60;
  const resetsAt = row.weekly_window_started_at > 0
    ? (row.weekly_window_started_at + WEEK_SECONDS) * 1000
    : null;

  return res.json({
    billing_mode: planLimits.billing_mode,
    percent,
    tokens: {
      used: row.weekly_tokens_used,
      quota: row.weekly_tokens_quota,
    },
    cost: {
      used: row.weekly_cost_used,
      quota: row.weekly_cost_quota,
    },
    resets_at: resetsAt,
  });
});

const accountIdFromRequest = (req: AuthedRequest): number => {
  return resolveAccountId(req.authUserId!);
};

app.post('/api/v1/vector-memory/chunks', async (req: AuthedRequest, res) => {
  if (!BACKEND_VECTOR_MEMORY_API_ENABLED) {
    return res.status(503).json({ error: 'backend_vector_memory_api_disabled' });
  }
  const userId = accountIdFromRequest(req);
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
  const userId = accountIdFromRequest(req);
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
  const userId = accountIdFromRequest(req);
  const chunkId = `${req.params.id || ''}`;

  try {
    const out = await VectorMemoryService.deleteChunk(userId, chunkId);
    return res.json(out);
  } catch (err: any) {
    const code = `${err?.message || 'vector_memory_delete_failed'}`;
    if (code === 'chunk_id_required') return res.status(400).json({ error: code });
    if (code === 'chunk_not_found') return res.status(404).json({ error: code });
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
  const userId = accountIdFromRequest(req);

  try {
    const out = await VectorMemoryService.deleteAll(userId);
    return res.json(out);
  } catch (err: any) {
    const code = `${err?.message || 'vector_memory_delete_all_failed'}`;
    return res.status(500).json({ error: code });
  }
});

app.get('/api/v1/chats', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const limit = Number.parseInt(`${req.query.limit || '50'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const chats = listUserChats(userId, limit, offset);
  const activeChatId = ensureActiveChat(userId);
  const safeLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 50));
  const safeOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
  res.json({ chats, active_chat_id: activeChatId, limit: safeLimit, offset: safeOffset });
});

app.get('/api/v1/chats/search', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const query = `${req.query.q || ''}`.trim();
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);

  if (query.length < 3) return res.status(400).json({ error: 'query_too_short_min_3' });

  const results = searchUserChats(userId, query, limit);
  return res.json({ results });
});

app.post('/api/v1/chats', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const title = `${req.body?.title || ''}`;
  const chatId = createUserChat(userId, title);
  res.status(201).json({ chat_id: chatId });
});

app.post('/api/v1/chats/:id/fork', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const sourceChatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(sourceChatId) || sourceChatId <= 0) {
    return res.status(400).json({ error: 'bad_chat_id' });
  }
  const fromMessageId = Number.parseInt(req.body?.from_message_id, 10);
  if (!Number.isFinite(fromMessageId) || fromMessageId <= 0) {
    return res.status(400).json({ error: 'bad_message_id' });
  }
  const title = req.body?.title ? String(req.body.title) : undefined;
  const result = forkChat(userId, sourceChatId, fromMessageId, title);
  if (!result) return res.status(404).json({ error: 'chat_or_message_not_found' });
  return res.status(201).json(result);
});

app.post('/api/v1/chats/:id/activate', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const ok = activateUserChat(userId, chatId);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true, active_chat_id: chatId });
});

app.put('/api/v1/chats/:id/rename', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const title = `${req.body?.title || ''}`.trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  const ok = renameUserChat(userId, chatId, title);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true });
});

app.put('/api/v1/chats/:id/bot-hidden', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const hidden = Boolean(req.body?.hidden);
  const ok = setChatBotHidden(userId, chatId, hidden);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true, bot_hidden: hidden });
});

app.delete('/api/v1/chats/:chatId/messages/:messageId', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.chatId, 10);
  const messageId = Number.parseInt(req.params.messageId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });
  const ok = deleteUserMessage(userId, chatId, messageId);
  if (!ok) return res.status(404).json({ error: 'message_not_found' });
  return res.json({ ok: true });
});

// List all attachments in a chat (for ToolsPanel "Documents" view)
app.get('/api/v1/chats/:chatId/attachments', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const attachments = getChatAttachments(userId, chatId);
  return res.json({ attachments });
});

// Delete a single attachment from a message by filename
app.delete('/api/v1/chats/:chatId/messages/:messageId/attachments/:filename', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.chatId, 10);
  const messageId = Number.parseInt(req.params.messageId, 10);
  const filename = path.basename(decodeURIComponent(req.params.filename || ''));
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });
  if (!filename) return res.status(400).json({ error: 'bad_filename' });
  const result = deleteMessageAttachment(userId, chatId, messageId, filename);
  if (!result.ok) return res.status(404).json({ error: 'attachment_not_found' });
  return res.json({ ok: true, token_count: result.token_count });
});

// Удаление изображения из messages.images по URL (картинка может принадлежать любому чату юзера)
app.delete('/api/v1/messages/:messageId/images', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const messageId = Number.parseInt(req.params.messageId, 10);
  const imageUrl = `${req.query.url || ''}`.trim();
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });
  if (!imageUrl) return res.status(400).json({ error: 'bad_url' });
  const result = deleteMessageImage(userId, messageId, imageUrl);
  if (!result.ok) return res.status(404).json({ error: 'image_not_found' });
  return res.json({ ok: true });
});

app.put('/api/v1/chats/:chatId/messages/:messageId', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.chatId, 10);
  const messageId = Number.parseInt(req.params.messageId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });
  const newContent = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!newContent) return res.status(400).json({ error: 'bad_content' });
  const result = editUserMessage(userId, chatId, messageId, newContent);
  if (!result.ok) return res.status(404).json({ error: 'message_not_found' });
  return res.json({ ok: true, token_count: result.token_count });
});

app.delete('/api/v1/chats/:chatId', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const ok = deleteUserChat(userId, chatId);
  if (!ok) return res.status(404).json({ error: 'chat_not_found' });
  return res.json({ ok: true });
});

// ── Send message to the account's Telegram identity ──


app.post('/api/v1/messages/:id/send-to-telegram', async (req: AuthedRequest, res) => {
  const TELEGRAM_TOKEN = `${process.env.TELEGRAM_TOKEN || ''}`.trim();
  if (!TELEGRAM_TOKEN) return res.status(500).json({ error: 'telegram_not_configured' });

  const userId = accountIdFromRequest(req);
  const messageId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(messageId) || messageId <= 0) return res.status(400).json({ error: 'bad_message_id' });

  const telegramIdentity = getTelegramIdentityForAccount(userId);
  const telegramId = Number(telegramIdentity?.provider_subject);
  if (!telegramId) return res.status(400).json({ error: 'telegram_not_linked' });

  console.log(`[send-to-telegram] accountId=${userId}, telegramId=${telegramId}, messageId=${messageId}`);

  // Fetch the message, verify ownership
  const row = db.prepare(`
    SELECT id, content, images FROM chat_messages WHERE id = ? AND user_id = ?
  `).get(messageId, userId) as { id: number; content: string; images: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'message_not_found' });

  const text = row.content || '';
  type MsgImage = { url: string; type: string };
  let images: MsgImage[] = [];
  if (row.images) {
    try { images = JSON.parse(row.images); } catch { images = []; }
  }

  console.log(`[send-to-telegram] message found, text_len=${text.length}, images_count=${images.length}, sending to telegram_id=${telegramId}`);

  const tgApiBase = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
  const assertTelegramFormOk = async (response: Response, method: string) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const description = data?.description || `${response.status} ${response.statusText}`;
      throw new Error(`${method}_failed: ${description}`);
    }
    return data;
  };

  try {
    if (images.length > 0) {
      // Collect image file paths
      const imageFiles: Buffer[] = [];
      for (const img of images) {
        const filename = path.basename(img.url);
        const filepath = resolveImageFile(filename);
        if (filepath) {
          imageFiles.push(await fs.promises.readFile(filepath));
        }
      }

      if (imageFiles.length > 0) {
        if (imageFiles.length === 1) {
          // Single photo with caption (caption limit 1024)
          const formData = new FormData();
          formData.append('chat_id', String(telegramId));
          formData.append('photo', new Blob([new Uint8Array(imageFiles[0])]), 'photo.webp');
          if (text) formData.append('caption', text.slice(0, 1024));

          await assertTelegramFormOk(
            await fetch(`${tgApiBase}/sendPhoto`, { method: 'POST', body: formData }),
            'sendPhoto'
          );

          // Send remaining text beyond the 1024 caption limit as separate messages
          if (text.length > 1024) {
            await sendTelegramMessage(telegramId, text.slice(1024), { strict: true, preferRich: true });
          }
        } else {
          // Multiple photos via sendMediaGroup (caption limit 1024)
          const media = imageFiles.map((buf, i) => ({
            type: 'photo',
            media: `attach://photo_${i}`,
            ...(i === 0 && text ? { caption: text.slice(0, 1024) } : {}),
          }));

          const formData = new FormData();
          formData.append('chat_id', String(telegramId));
          formData.append('media', JSON.stringify(media));
          imageFiles.forEach((buf, i) => {
            formData.append(`photo_${i}`, new Blob([new Uint8Array(buf)]), `photo_${i}.webp`);
          });

          await assertTelegramFormOk(
            await fetch(`${tgApiBase}/sendMediaGroup`, { method: 'POST', body: formData }),
            'sendMediaGroup'
          );

          // Send remaining text beyond the 1024 caption limit as separate messages
          if (text.length > 1024) {
            await sendTelegramMessage(telegramId, text.slice(1024), { strict: true, preferRich: true });
          }
        }
      } else {
        // Images existed but files not found on disk — send text only (chunked)
        const fallbackText = text || '(изображение недоступно)';
        await sendTelegramMessage(telegramId, fallbackText, { strict: true, preferRich: true });
      }
    } else {
      // Text only — split into chunks (Telegram limit is 4096, use 4000 with margin)
      if (!text) return res.status(400).json({ error: 'empty_message' });
      await sendTelegramMessage(telegramId, text, { strict: true, preferRich: true });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[send-to-telegram] Failed:', formatSafeError(err));
    return res.status(500).json({ error: 'telegram_send_failed' });
  }
});

app.get('/api/v1/chats/:id/messages', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const messages = getChatMessages(userId, chatId, limit, offset);
  res.json({ messages, limit: Math.max(1, Math.min(100, limit || 20)), offset: Math.max(0, offset || 0) });
});

app.get('/api/v1/chats/:id/media', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const limit = Number.parseInt(`${req.query.limit || '100'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const media = getChatMedia(userId, chatId, limit, offset);
  res.json({ media, limit, offset });
});

// Медиа (изображения) из всех чатов пользователя.
app.get('/api/v1/media/all', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const limit = Number.parseInt(`${req.query.limit || '100'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const media = getAllUserMedia(userId, limit, offset);
  res.json({ media, limit, offset });
});

// Суммарные токены контекста чата (сообщения без системного промпта).
// Системный промпт динамический, считается отдельно при необходимости.
app.get('/api/v1/chats/:id/context-tokens', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const chatId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) return res.status(400).json({ error: 'bad_chat_id' });
  const tokens = getChatContextTokens(userId, chatId);
  res.json(tokens);
});

app.post('/api/v1/chat/send', async (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const text = `${req.body?.text || ''}`;
  const chatIdRaw = req.body?.chat_id;
  const chatId = Number.isFinite(Number(chatIdRaw)) ? Math.floor(Number(chatIdRaw)) : undefined;

  // Parse optional images array
  const imagesRaw: Array<any> = Array.isArray(req.body?.images) ? req.body.images : [];
  const imageUser = getUserById(userId);
  if (imagesRaw.length > 0 && imageUser && !areImageAttachmentsAllowedForPlan(imageUser.plan, imageUser.is_admin === 1)) {
    return res.status(403).json({ error: 'images_not_allowed_for_plan' });
  }
  const MAX_IMAGE_BYTES_API = 20 * 1024 * 1024;
  const images = imagesRaw
    .map((img: any) => {
      const base64 = `${img?.base64 || ''}`.trim();
      const mimeType = `${img?.mime_type || 'image/jpeg'}`.trim() || 'image/jpeg';
      return { base64, mimeType };
    })
    .filter(img => img.base64.length > 0);

  if (images.length > MAX_IMAGE_ATTACHMENTS_PER_REQUEST) {
    return res.status(400).json({ error: `too_many_images_max_${MAX_IMAGE_ATTACHMENTS_PER_REQUEST}` });
  }

  // Validate image sizes — обычные HTTP-ошибки до переключения на SSE
  let totalImageBytes = 0;
  for (const img of images) {
    const buf = Buffer.from(img.base64, 'base64');
    if (!buf.length) continue;
    if (buf.length > MAX_IMAGE_BYTES_API) {
      return res.status(413).json({ error: 'image_too_large' });
    }
    totalImageBytes += buf.length;
    if (totalImageBytes > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES) {
      return res.status(413).json({ error: 'image_payload_too_large' });
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
      console.error('[chat/send] failed to save image thumbnails:', formatSafeError(err));
    }
  }

  // Parse optional documents array (attachments)
  const documentsRaw: Array<any> = Array.isArray(req.body?.documents) ? req.body.documents : [];
  let savedUserAttachments: any[] | null = null;
  if (documentsRaw.length > 0) {
    try {
      const { saveUserDocument } = await import('./services/attachment-storage.js');
      const saved: any[] = [];
      for (const doc of documentsRaw) {
        const base64 = `${doc?.base64 || ''}`.trim();
        const filename = `${doc?.filename || 'document'}`.trim();
        if (!base64) continue;
        const buf = Buffer.from(base64, 'base64');
        if (!buf.length) continue;
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return res.status(413).json({ error: 'document_too_large', filename });
        }
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          return res.status(400).json({ error: 'unsupported_document_format', filename, ext });
        }
        const extractedText = await parseDocument(buf, filename);
        const stored = await saveUserDocument(buf, filename);
        saved.push({
          name: filename,
          size_bytes: buf.length,
          mime_type: guessMimeType(filename),
          extracted_text: extractedText,
          url: stored.url,
          filename: stored.filename,
        });
      }
      savedUserAttachments = saved.length > 0 ? saved : null;
    } catch (err: any) {
      console.error('[chat/send] failed to save documents:', formatSafeError(err));
      return res.status(400).json({ error: 'document_parse_failed', detail: err?.message || String(err) });
    }
  }

  // Parse optional display manifest from desktop client
  const displayManifest = req.body?.display_manifest;
  const currentDisplayState = req.body?.current_display_state ?? null;
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
    const rawUserRecord = getUserById(userId);
    const result = await sendMessageThroughAi(userId, text, chatId, {
      ...(images.length > 0 ? { images } : {}),
      userImages: savedUserImages,
      ...(savedUserAttachments ? { userAttachments: savedUserAttachments } : {}),
      displayManifest,
      currentDisplayState,
      isDesktop,
      isVoice,
      activeMacros: enabledMacros,
      preferredModel: req.body?.preferred_model || undefined,
      regenerateHint: req.body?.regenerate_hint || undefined,
      regenerateFromHistory: Boolean(req.body?.regenerate_from_history),
      skipUserHistory: Boolean(req.body?.skip_user_history),
      featureFlags: rawUserRecord ? parseFeatureFlags(rawUserRecord) : undefined,
      diceRollMode: Boolean(parseUiSettings(rawUserRecord ?? getUserById(userId)).dice_roll_enabled),
      ...(() => { const fv = resolveDiceForceValue(req.body?.dice_mode); return fv !== undefined ? { diceRollForceValue: fv } : {}; })(),
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
      },
      onDiceRoll: (roll) => {
        res.write(`event: dice_roll\ndata: ${JSON.stringify({ roll })}\n\n`);
      },
      onStreamToken: (text) => {
        res.write(`event: stream_token\ndata: ${JSON.stringify({ text })}\n\n`);
      },
      onReasoningStream: (text) => {
        res.write(`event: reasoning_token\ndata: ${JSON.stringify({ text })}\n\n`);
      }
    });

    res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  } catch (err: any) {
    const payload = buildLocalizedAiError(err, userId);
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
  }
});

// ── Остановка генерации ────────────────────────────────────────────────────
app.post('/api/v1/chat/stop', authMiddleware, (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const controller = activeGenerations.get(userId);
  if (controller) {
    controller.abort();
    return res.json({ ok: true, message: 'Остановлено' });
  }
  return res.json({ ok: false, message: 'Нет активной генерации' });
});

// ── TTS (Cartesia cloud) ────────────────────────────────────────────────

app.get('/api/v1/tts/providers', async (_req: AuthedRequest, res) => {
  const providers: Array<{
    id: string;
    name: string;
    voices: Array<{
      id: string;
      name: string;
      description?: string;
      language?: string;
      gender?: string;
    }>;
  }> = [];

  if (isCartesiaConfigured()) {
    try {
      const allVoices = await fetchCartesiaVoices();
      const supportedLanguageBases = new Set(
        SUPPORTED_LANGUAGES.map(language => language.toLowerCase().split('-')[0]),
      );
      const voices = allVoices.filter(voice => {
        const languageBase = `${voice.language || ''}`.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
        return supportedLanguageBases.has(languageBase);
      });

      if (voices.length > 0) {
        providers.push({ id: 'cartesia', name: 'Cartesia', voices });
      }
    } catch (err: any) {
      console.error('[tts/providers] failed to load Cartesia:', err.message);
    }
  }

  return res.json({ providers });
});

// Generate TTS audio and bind to message
app.post('/api/v1/tts/generate', async (req: AuthedRequest, res) => {
  if (!isCartesiaConfigured()) {
    return res.status(503).json({ error: 'tts_not_configured' });
  }

  const userId = accountIdFromRequest(req);
  const text = `${req.body?.text || ''}`.trim();
  const voiceId = `${req.body?.voice_id || ''}`.trim();
  const language = `${req.body?.language || 'ru'}`.trim();
  const messageId = req.body?.message_id as number | undefined;

  if (!text) return res.status(400).json({ error: 'text_required' });
  if (!voiceId) return res.status(400).json({ error: 'voice_id_required' });

  // If message_id provided, verify ownership
  if (messageId) {
    const ownerId = getChatMessageOwner(messageId);
    if (ownerId !== userId) {
      return res.status(403).json({ error: 'access_denied' });
    }
  }

  try {
    const result = await generateTtsAudio(text, voiceId, language);
    const saved = await saveTtsAudio(result.audioBuffer, '.mp3');

    // Bind audio to message if requested
    if (messageId) {
      updateChatMessageAudio(userId, messageId, {
        url: saved.url,
        tts_type: 'cartesia',
        voice_id: voiceId,
      });
    }

    return res.json({
      audio_url: saved.url,
      tts_type: 'cartesia',
      voice_id: voiceId,
    });
  } catch (err: any) {
    console.error('[tts/generate] error:', err.message);
    return res.status(500).json({ error: 'tts_generation_error', message: err.message });
  }
});

// Get or generate a voice preview sample (cached per voice_id in DB)
app.get('/api/v1/tts/preview', async (req: AuthedRequest, res) => {
  if (!isCartesiaConfigured()) {
    return res.status(503).json({ error: 'tts_not_configured' });
  }

  const voiceId = `${req.query.voice_id || ''}`.trim();
  const language = `${req.query.language || 'ru'}`.trim();
  const previewText = `${req.query.text || 'Chatter'}`.trim();

  if (!voiceId) return res.status(400).json({ error: 'voice_id_required' });
  if (!previewText) return res.status(400).json({ error: 'text_required' });
  if (previewText.length > 200) return res.status(400).json({ error: 'text_too_long' });

  // Check cache
  const cached = db.prepare('SELECT audio_url FROM tts_voice_previews WHERE voice_id = ?').get(voiceId) as { audio_url: string } | undefined;
  if (cached) {
    return res.json({ audio_url: cached.audio_url });
  }

  // Generate and cache
  try {
    const result = await generateTtsAudio(previewText, voiceId, language);
    const saved = await saveTtsAudio(result.audioBuffer, '.mp3');
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO tts_voice_previews (voice_id, audio_url, language, created_at) VALUES (?, ?, ?, ?)').run(voiceId, saved.url, language, now);
    return res.json({ audio_url: saved.url });
  } catch (err: any) {
    console.error('[tts/preview] error:', err.message);
    return res.status(500).json({ error: 'tts_preview_error', message: err.message });
  }
});

app.get('/api/v1/notes', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const limit = Number.parseInt(`${req.query.limit || '20'}`, 10);
  const offset = Number.parseInt(`${req.query.offset || '0'}`, 10);
  const query = `${req.query.query || ''}`;
  const notes = listNotes(userId, limit, offset, query);
  const total = countNotes(userId, query);
  res.json({ notes, total, limit: Math.max(1, Math.min(50, limit || 20)), offset: Math.max(0, offset || 0) });
});

app.post('/api/v1/notes', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const title = `${req.body?.title || ''}`;
  const content = `${req.body?.content || ''}`;

  const created = createNote(userId, title, content);
  if (!created.ok) {
    if (created.error === 'content_required') return res.status(400).json({ error: created.error });
    if (created.error === 'title_too_long' || created.error === 'content_too_long') return res.status(422).json({ error: created.error });
    return res.status(400).json({ error: created.error });
  }
  return res.status(201).json({ note_id: created.id });
});

app.delete('/api/v1/notes/:id', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_note_id' });
  const ok = deleteNote(userId, noteId);
  if (!ok) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ ok: true });
});

app.get('/api/v1/notes/:id', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId) || noteId <= 0) return res.status(400).json({ error: 'bad_note_id' });
  const note = getNoteById(userId, noteId);
  if (!note) return res.status(404).json({ error: 'note_not_found' });
  return res.json({ note });
});

app.get('/api/v1/tasks', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const statusRaw = `${req.query.status || 'pending'}` as 'pending' | 'done' | 'error' | 'all';
  const status = ['pending', 'done', 'error', 'all'].includes(statusRaw) ? statusRaw : 'pending';
  const limit = Number.parseInt(`${req.query.limit || '50'}`, 10);
  const tasks = listTasks(userId, limit, status);
  res.json({ tasks });
});

app.post('/api/v1/tasks', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
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
  const userId = accountIdFromRequest(req);
  const taskId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId) || taskId <= 0) return res.status(400).json({ error: 'bad_task_id' });
  const ok = deletePendingTask(userId, taskId);
  if (!ok) return res.status(404).json({ error: 'task_not_found_or_not_pending' });
  return res.json({ ok: true });
});

// ── Map Pins (JWT) ─────────────────────────────────────────────────────────

app.get('/api/v1/map-pins', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const pins = listMapPins(userId);
  return res.json({ pins });
});

app.post('/api/v1/map-pins', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const lat = typeof req.body?.lat === 'number' ? req.body.lat : NaN;
  const lng = typeof req.body?.lng === 'number' ? req.body.lng : NaN;
  const label = `${req.body?.label || ''}`;
  const result = createMapPin(userId, lat, lng, label);
  if (result.ok === false) return res.status(400).json({ error: result.error });
  return res.status(201).json({ pin_id: result.id });
});

app.put('/api/v1/map-pins/:id', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
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
  const userId = accountIdFromRequest(req);
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

  const identities = getAccountIdentities(userId);
  const hasPasswordIdentity = identities.some(identity => identity.provider === 'password');
  const telegramIdentity = getTelegramIdentityForAccount(userId);
  if (telegramIdentity) {
    return res.json({
      linked: true,
      tg_id: Number(telegramIdentity.provider_subject),
      tg_username: telegramIdentity.username || null,
      can_unlink: hasPasswordIdentity,
    });
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
  const dataOwner = req.body?.data_owner;
  if (dataOwner !== 'desktop' && dataOwner !== 'telegram') {
    return res.status(400).json({ error: 'data_owner_required' });
  }

  try {
    const split = unlinkTelegramFromAccount(userId, dataOwner);
    const desktopUser = getUserById(split.desktop_account_id);
    if (!desktopUser) return res.status(500).json({ error: 'desktop_account_create_failed' });
    const tokens = issueAuthTokens(split.desktop_account_id);
    console.log('[accounts] Telegram identity unlinked', split);
    return res.json({
      ok: true,
      ...tokens,
      user: toAuthUserDto(desktopUser),
      split,
    });
  } catch (error) {
    const code = formatSafeError(error);
    if (code === 'telegram_not_linked') return res.status(400).json({ error: 'not_linked' });
    if (code === 'password_identity_required') {
      return res.status(409).json({ error: 'password_identity_required' });
    }
    console.error('[accounts] Telegram unlink failed:', code);
    return res.status(500).json({ error: 'telegram_unlink_failed' });
  }
});

// ── Prompts (public, for desktop) ──────────────────────────────────────

app.get('/api/v1/prompts', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const prompts = getAllPrompts();
  const user = getUserById(userId);
  const userPrompts = getUserPrompts(userId);
  return res.json({
    prompts: prompts.map(p => ({ id: p.id, name: p.name, description: p.description, is_default: p.is_default })),
    custom_prompts: userPrompts.map(p => ({
      id: toUserPromptSelectedId(p.id),
      name: p.name,
      description: p.description,
      content: p.content,
    })),
    selected_prompt_id: user?.selected_prompt_id ?? null,
    custom_prompt_content: user?.custom_prompt_content ?? null,
  });
});

app.post('/api/v1/prompts/select', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const promptId = Number(req.body?.prompt_id);
  if (!Number.isFinite(promptId)) return res.status(400).json({ error: 'bad_prompt_id' });

  if (promptId === -1) {
    // Legacy "Custom" (blank template) — still allow for backward compat
    selectUserCustomPrompt(userId);
  } else if (promptId <= -USER_PROMPT_OFFSET) {
    // User custom prompt: verify ownership
    const rowId = parseUserPromptRowId(promptId);
    if (rowId === null) return res.status(400).json({ error: 'bad_prompt_id' });
    const up = getUserPromptById(userId, rowId);
    if (!up) return res.status(404).json({ error: 'prompt_not_found' });
    updateUserPrompt(userId, promptId);
  } else {
    const prompt = getPromptById(promptId);
    if (!prompt) return res.status(404).json({ error: 'prompt_not_found' });
    updateUserPrompt(userId, promptId);
  }
  return res.json({ ok: true });
});

// Create a new custom prompt
app.post('/api/v1/prompts/custom', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const name = `${req.body?.name || ''}`.trim();
  const description = `${req.body?.description || ''}`.trim();
  const content = `${req.body?.content || ''}`;
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (content.length > 10000) return res.status(400).json({ error: 'content_too_long' });

  const result = createUserPrompt(userId, name, description, content);
  const newRowId = Number(result.lastInsertRowid);
  const selectedId = toUserPromptSelectedId(newRowId);
  // Auto-select the newly created prompt
  updateUserPrompt(userId, selectedId);
  return res.json({ ok: true, prompt_id: selectedId });
});

// Update an existing custom prompt
app.put('/api/v1/prompts/custom/:selectedId', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const selectedId = Number(req.params.selectedId);
  if (!Number.isFinite(selectedId) || selectedId > -USER_PROMPT_OFFSET) {
    return res.status(400).json({ error: 'bad_prompt_id' });
  }
  const rowId = parseUserPromptRowId(selectedId);
  if (rowId === null) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getUserPromptById(userId, rowId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  const fields: { name?: string; description?: string; content?: string } = {};
  if (req.body?.name !== undefined) {
    const name = `${req.body.name}`.trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    fields.name = name;
  }
  if (req.body?.description !== undefined) {
    fields.description = `${req.body.description}`.trim();
  }
  if (req.body?.content !== undefined) {
    const content = `${req.body.content}`;
    if (content.length > 10000) return res.status(400).json({ error: 'content_too_long' });
    fields.content = content;
  }

  updateUserPromptRow(userId, rowId, fields);
  return res.json({ ok: true });
});

// Delete a custom prompt
app.delete('/api/v1/prompts/custom/:selectedId', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const selectedId = Number(req.params.selectedId);
  if (!Number.isFinite(selectedId) || selectedId > -USER_PROMPT_OFFSET) {
    return res.status(400).json({ error: 'bad_prompt_id' });
  }
  const rowId = parseUserPromptRowId(selectedId);
  if (rowId === null) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getUserPromptById(userId, rowId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  deleteUserPromptRow(userId, rowId);
  // If deleted prompt was selected, reset to default
  const user = getUserById(userId);
  if (user?.selected_prompt_id === selectedId) {
    db.prepare('UPDATE users SET selected_prompt_id = NULL WHERE id = ?').run(userId);
  }
  return res.json({ ok: true });
});

// Legacy: update single custom_prompt_content (kept for backward compat)
app.put('/api/v1/prompts/custom', (req: AuthedRequest, res) => {
  const userId = req.authUserId!;
  const content = `${req.body?.content || ''}`;
  updateUserCustomPrompt(userId, content);
  return res.json({ ok: true });
});

// AI prompt generation — uses user's preferred model (or auto PRO)
app.post('/api/v1/prompts/generate', async (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const instruction = `${req.body?.instruction || ''}`.trim();
  const currentContent = `${req.body?.current_content || ''}`;
  const detail = `${req.body?.detail || 'medium'}`.trim() as 'minimal' | 'medium' | 'detailed' | 'none';

  if (!instruction) return res.status(400).json({ error: 'instruction_required' });

  const user = getUserById(userId);

  const detailKeyMap: Record<string, string> = {
    minimal: 'confirmations.promptGenDetailMinimal',
    medium: 'confirmations.promptGenDetailMedium',
    detailed: 'confirmations.promptGenDetailDetailed',
    none: '',
  };

  const detailHint = detailKeyMap[detail] ? translateForLanguage(user?.language, detailKeyMap[detail]) : '';
  const detailSuffix = detailHint ? ` ${detailHint}` : '';

  const hasExisting = currentContent.trim().length > 0;
  const systemPrompt = translateForLanguage(user?.language, 'confirmations.promptGenSystem', { detail: detailSuffix });
  const userPrompt = hasExisting
    ? translateForLanguage(user?.language, 'confirmations.promptGenUserEdit', { instruction, currentContent })
    : translateForLanguage(user?.language, 'confirmations.promptGenUserNew', { instruction });

  try {
    const requestedModelId = typeof req.body?.preferred_model === 'string' ? req.body.preferred_model.trim() : '';
    const preferredModelId = requestedModelId || user?.preferred_model || null;
    const manualModel = preferredModelId ? resolveManualModel(preferredModelId, user?.is_admin === 1) : undefined;
    console.log('[prompts/generate] model selection', {
      authUserId: req.authUserId,
      accountId: userId,
      bodyPreferredModel: requestedModelId || null,
      dbPreferredModel: user?.preferred_model || null,
      preferredModelId,
      manualResolved: Boolean(manualModel),
      manualApiModel: manualModel?.apiModelName || null,
      manualBaseURL: manualModel?.baseURL || null,
    });
    if (preferredModelId && !manualModel) {
      console.warn(`[prompts/generate] preferred_model "${preferredModelId}" not found in MODELS_MANUAL, falling back to auto`);
    }

    const result = await runCompletion('pro', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 25000,
    }, manualModel);
    console.log('[prompts/generate] completion route', {
      usedProvider: result.usedProvider,
      usedModel: result.usedModel,
      baseURLUsed: result.baseURLUsed || null,
      manualFallback: Boolean(result.manualFallback),
      failedModels: result.failedModels || [],
      failedProviders: result.failedProviders || [],
    });

    const generated = result.response?.choices?.[0]?.message?.content;
    if (typeof generated !== 'string' || !generated.trim()) {
      return res.status(500).json({ error: 'empty_ai_response' });
    }
    return res.json({ generated_prompt: generated.trim() });
  } catch (err) {
    console.error('[prompts/generate]', formatSafeError(err));
    return res.status(500).json({ error: 'ai_call_failed' });
  }
});

// ── Internal: Telegram Link Verify (bot) ──────────────────────────────────

const TELEGRAM_LINK_MAX_ATTEMPTS = 3;
const TELEGRAM_LINK_ATTEMPT_WINDOW_MS =10 * 60 * 1000;
const telegramLinkAttempts = new Map<number, { failedAttempts: number; resetAt: number }>();

const getTelegramLinkAttemptState = (tgId: number) => {
  const now = Date.now();
  for (const [storedTgId, state] of telegramLinkAttempts) {
    if (state.resetAt <= now) telegramLinkAttempts.delete(storedTgId);
  }
  const current = telegramLinkAttempts.get(tgId);
  if (!current || current.resetAt <= now) {
    const fresh = { failedAttempts: 0, resetAt: now + TELEGRAM_LINK_ATTEMPT_WINDOW_MS };
    telegramLinkAttempts.set(tgId, fresh);
    return fresh;
  }
  return current;
};

app.post('/internal/link/verify', internalAuth, (req, res) => {
  const code = `${req.body?.code || ''}`.trim();
  const tgId = Number(req.body?.tg_id);
  const tgUsername = `${req.body?.tg_username || ''}`.trim() || null;

  if (!code) return res.status(400).json({ error: 'code_required' });
  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'tg_id_required' });

  const tgAccountId = getAccountIdByTelegramId(tgId);
  const tgUser = tgAccountId ? getUserById(tgAccountId) : undefined;
  if (!tgUser) return res.status(404).json({ error: 'telegram_user_not_found' });
  if (tgUser.status !== 'approved' && tgUser.is_admin !== 1) {
    return res.status(403).json({ error: 'telegram_user_not_approved', status: tgUser.status });
  }

  const attemptState = getTelegramLinkAttemptState(tgId);
  if (attemptState.failedAttempts >= TELEGRAM_LINK_MAX_ATTEMPTS) {
    return res.status(429).json({
      error: 'too_many_link_attempts',
      retry_after: Math.max(1, Math.ceil((attemptState.resetAt - Date.now()) / 1000)),
    });
  }

  const result = verifyLinkCode(code);
  if (!result.ok) {
    attemptState.failedAttempts += 1;
    if (attemptState.failedAttempts >= TELEGRAM_LINK_MAX_ATTEMPTS) {
      return res.status(429).json({
        error: 'too_many_link_attempts',
        retry_after: Math.max(1, Math.ceil((attemptState.resetAt - Date.now()) / 1000)),
      });
    }
    return res.status(404).json({ error: 'invalid_or_expired_code' });
  }

  telegramLinkAttempts.delete(tgId);

  const webUserId = resolveAccountId(result.userId!);
  const webUser = getUserById(webUserId);
  if (!webUser) return res.status(404).json({ error: 'web_user_not_found' });

  const accountId = linkAccountToTelegram(webUserId, tgId, tgUsername);
  return res.json({ ok: true, account_id: accountId, tg_id: tgId, tg_username: tgUsername });
});

app.post('/internal/link/unlink', internalAuth, (req, res) => {
  const tgId = Number(req.body?.tg_id);
  const dataOwner = req.body?.data_owner;
  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'tg_id_required' });
  if (dataOwner !== 'desktop' && dataOwner !== 'telegram') {
    return res.status(400).json({ error: 'data_owner_required' });
  }

  const accountId = getAccountIdByTelegramId(tgId);
  if (!accountId) return res.status(404).json({ error: 'not_linked' });
  try {
    const split = unlinkTelegramFromAccount(accountId, dataOwner);
    console.log('[accounts] Telegram identity unlinked through internal API', split);
    return res.json({ ok: true, split });
  } catch (error) {
    const code = formatSafeError(error);
    if (code === 'password_identity_required') {
      return res.status(409).json({ error: 'password_identity_required' });
    }
    console.error('[accounts] internal Telegram unlink failed:', code);
    return res.status(500).json({ error: 'telegram_unlink_failed' });
  }
});

// ── Internal: Prompts CRUD (Telegram bot, requires actor_user_id) ────────────

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

app.post('/internal/prompts', internalAuth, internalAdminAuth, (req, res) => {
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

app.put('/internal/prompts/:id/name', internalAuth, internalAdminAuth, (req, res) => {
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

app.put('/internal/prompts/:id/description', internalAuth, internalAdminAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const description = `${req.body?.description || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  updatePromptDescription(promptId, description);
  return res.json({ ok: true });
});

app.put('/internal/prompts/:id/content', internalAuth, internalAdminAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const content = `${req.body?.content || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  if (!content) return res.status(400).json({ error: 'content_required' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  updatePromptContent(promptId, content);
  return res.json({ ok: true });
});

app.put('/internal/prompts/:id/default', internalAuth, internalAdminAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  setDefaultPrompt(promptId);
  return res.json({ ok: true });
});

app.delete('/internal/prompts/:id', internalAuth, internalAdminAuth, (req, res) => {
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

// ── Internal (admin-panel via manager): Admin Prompts CRUD ───────────────────

app.get('/internal/admin/prompts', internalAuth, (_req, res) => {
  const prompts = getAllPrompts();
  return res.json({ prompts });
});

app.get('/internal/admin/prompts/:id', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  const prompt = getPromptById(promptId);
  if (!prompt) return res.status(404).json({ error: 'prompt_not_found' });
  return res.json({ prompt });
});

app.post('/internal/admin/prompts', internalAuth, (req, res) => {
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

app.put('/internal/admin/prompts/:id/name', internalAuth, (req, res) => {
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

app.put('/internal/admin/prompts/:id/description', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const description = `${req.body?.description || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  updatePromptDescription(promptId, description);
  return res.json({ ok: true });
});

app.put('/internal/admin/prompts/:id/content', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  const content = `${req.body?.content || ''}`.trim();
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });
  if (!content) return res.status(400).json({ error: 'content_required' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  updatePromptContent(promptId, content);
  return res.json({ ok: true });
});

app.put('/internal/admin/prompts/:id/default', internalAuth, (req, res) => {
  const promptId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(promptId) || promptId <= 0) return res.status(400).json({ error: 'bad_prompt_id' });

  const existing = getPromptById(promptId);
  if (!existing) return res.status(404).json({ error: 'prompt_not_found' });

  setDefaultPrompt(promptId);
  return res.json({ ok: true });
});

app.delete('/internal/admin/prompts/:id', internalAuth, (req, res) => {
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
  const userId = resolveInternalAccountId(req.body?.user_id);
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
  const userId = resolveInternalAccountId(req.body?.user_id);
  const content = `${req.body?.content || ''}`;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserCustomPrompt(userId, content);
  return res.json({ ok: true });
});

// ── Internal: Timezone ────────────────────────────────────────────────────

app.post('/internal/user/timezone', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const offset = Number(req.body?.timezone_offset);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(offset) || offset < -12 || offset > 14) return res.status(400).json({ error: 'bad_timezone_offset' });

  setUserTimezone(userId, Math.floor(offset));
  return res.json({ ok: true });
});

// ── Internal: Context Token Limit (for TG bot) ─────────────────────────────

app.get('/internal/user/context-tokens-limit', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.query?.user_id || req.body?.user_id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({
    max_context_tokens: resolveMaxContextTokens(user),
    max_context_tokens_limit: user.max_context_tokens_limit || 30000,
  });
});

app.post('/internal/user/context-tokens-limit', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const maxContextTokens = Number(req.body?.max_context_tokens);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!Number.isFinite(maxContextTokens) || maxContextTokens < 1000) return res.status(400).json({ error: 'bad_max_context_tokens' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const hardLimit = Number.isFinite(user.max_context_tokens_limit) && user.max_context_tokens_limit! > 0
    ? Math.floor(user.max_context_tokens_limit!) : 30000;
  const clamped = Math.min(Math.floor(maxContextTokens), hardLimit);
  updateUserMaxContextTokens(userId, clamped);
  return res.json({ ok: true, max_context_tokens: clamped, max_context_tokens_limit: hardLimit });
});

// ── Internal: Mail Accounts Management ────────────────────────────────────

const getMailAccountsPayload = (userId: number) => {
  const user = db.prepare('SELECT active_mail_account_id FROM users WHERE id = ?').get(userId) as { active_mail_account_id?: number | null } | undefined;
  const activeAccountId = Number(user?.active_mail_account_id) || null;
  const accounts = getMailAccountsForUser(userId).map(account => ({
    id: account.id,
    provider: account.provider,
    label: account.label,
    email: account.email,
    login: account.imap_user,
    imap_host: account.imap_host,
    imap_port: account.imap_port,
    imap_secure: account.imap_secure === 1,
    smtp_host: account.smtp_host,
    smtp_port: account.smtp_port,
    smtp_secure: account.smtp_secure === 1,
    is_active: account.id === activeAccountId
  }));

  return { accounts, active_account_id: activeAccountId };
};

const setupMailAccount = async (userId: number, provider: MailProvider, email: string, appPassword: string, body: any = {}) => {
  const accountId = Number.isInteger(Number(body.mail_account_id)) && Number(body.mail_account_id) > 0
    ? Number(body.mail_account_id) : null;
  const verified = await verifyMailAccountConnection(provider, email, appPassword, {
    login: body.login,
    imapHost: body.imap_host,
    imapPort: body.imap_port,
    imapSecure: body.imap_secure === false || body.imap_secure === 0 ? 0 : 1,
    smtpHost: body.smtp_host,
    smtpPort: body.smtp_port,
    smtpSecure: body.smtp_secure === false || body.smtp_secure === 0 ? 0 : 1
  });
  const encryptedPass = encryptSecret(verified.appPassword);
  const account = upsertMailAccount({
    userId,
    accountId,
    provider,
    label: body.label,
    email: verified.email,
    encryptedPassword: encryptedPass,
    config: verified.config
  });
  setActiveMailAccount(userId, account);
  return getMailAccountsPayload(userId);
};

const removeMailAccount = (userId: number, accountId: number) => {
  const account = getMailAccountById(userId, accountId);
  if (!account) throw new Error('mail_account_not_found');

  const currentUser = db.prepare('SELECT active_mail_account_id FROM users WHERE id = ?').get(userId) as { active_mail_account_id?: number | null } | undefined;
  deleteMailAccount(userId, accountId);
  const remaining = getMailAccountsForUser(userId);

  if (!remaining.length) {
    clearUserMailSettings(userId);
    return getMailAccountsPayload(userId);
  }

  const nextActive = Number(currentUser?.active_mail_account_id) !== accountId
    ? remaining.find(item => item.id === Number(currentUser?.active_mail_account_id)) || remaining[0]
    : remaining[0];
  setActiveMailAccount(userId, nextActive);
  return getMailAccountsPayload(userId);
};

app.get('/internal/mail/accounts', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.query?.user_id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json(getMailAccountsPayload(userId));
});

app.post('/internal/mail/setup', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const provider = normalizeMailProvider(req.body?.provider);
  const email = `${req.body?.email || ''}`.trim();
  const appPassword = `${req.body?.app_password || ''}`;

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!provider) return res.status(400).json({ error: 'bad_provider' });
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!appPassword) return res.status(400).json({ error: 'app_password_required' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  try {
    const payload = await setupMailAccount(userId, provider, email, appPassword, req.body);
    return res.json({
      ok: true,
      accounts: payload.accounts.map(account => ({ id: account.id, provider: account.provider, label: account.label, imap_user: account.email }))
    });
  } catch (err: any) {
    const code = `${err?.message || 'mail_setup_failed'}`;
    if (['bad_email', 'app_password_required', 'bad_provider', 'bad_mail_host', 'private_mail_host_forbidden', 'mail_login_required'].includes(code)) return res.status(400).json({ error: code });
    if (['mail_auth_failed', 'mail_smtp_auth_failed'].includes(code)) return res.status(401).json({ error: code });
    if (code === 'mail_runtime_unavailable') return res.status(503).json({ error: code });
    if (['mail_connection_failed', 'mail_smtp_connection_failed'].includes(code)) return res.status(502).json({ error: code });
    return res.status(500).json({ error: 'mail_setup_failed' });
  }
});

app.post('/internal/mail/use', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const reference = `${req.body?.reference || req.body?.provider || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!reference) return res.status(400).json({ error: 'mail_account_required' });

  const account = resolveMailAccountReference(userId, reference);
  if (!account) return res.status(404).json({ error: 'mail_account_not_found' });

  setActiveMailAccount(userId, account);
  return res.json({ ok: true, id: account.id, provider: account.provider, imap_user: account.email });
});

app.delete('/internal/mail/account', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const reference = `${req.body?.reference || req.body?.provider || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  if (!reference) {
    clearUserMailSettings(userId);
    deleteAllMailAccounts(userId);
    return res.json({ ok: true, deleted: 'all' });
  }

  const account = resolveMailAccountReference(userId, reference);
  if (!account) return res.status(404).json({ error: 'mail_account_not_found' });
  const payload = removeMailAccount(userId, account.id);
  const nextActive = payload.accounts.find(item => item.is_active);
  return res.json({
    ok: true,
    deleted: account.email,
    remaining: payload.accounts.map(item => ({ provider: item.provider, imap_user: item.email })),
    new_active: nextActive ? { provider: nextActive.provider, imap_user: nextActive.email } : undefined
  });
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
  const language = req.body?.language ?? null;

  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'bad_tg_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  upsertTelegramUser(tgId, name, role, status, tgUsername, defaultPromptId, language);
  const accountId = getAccountIdByTelegramId(tgId);
  if (!accountId) return res.status(500).json({ error: 'telegram_identity_create_failed' });
  const user = getUserById(accountId);
  return res.json({ ok: true, user: user ? withAccountIdentities(user) : null });
});

app.post('/internal/users/create-pending', internalAuth, (req, res) => {
  const tgId = Number(req.body?.tg_id);
  const name = req.body?.name ?? null;
  const tgUsername = req.body?.tg_username ?? null;
  const defaultPromptId = req.body?.default_prompt_id ?? null;
  const language = req.body?.language ?? null;

  if (!Number.isFinite(tgId) || tgId <= 0) return res.status(400).json({ error: 'bad_tg_id' });

  createPendingTelegramUser(tgId, name, tgUsername, defaultPromptId, language);
  const accountId = getAccountIdByTelegramId(tgId);
  if (!accountId) return res.status(500).json({ error: 'telegram_identity_create_failed' });
  const user = getUserById(accountId);
  return res.json({ ok: true, user: user ? withAccountIdentities(user) : null });
});

const withAccountIdentities = <T extends { id: number }>(user: T) => {
  const identities = getAccountIdentities(user.id);
  const telegramIdentity = identities.find(identity => identity.provider === 'telegram');
  return {
    ...user,
    account_id: user.id,
    telegram_id: telegramIdentity ? Number(telegramIdentity.provider_subject) : null,
    telegram_username: telegramIdentity?.username ?? null,
    identities: identities.map(identity => ({
      provider: identity.provider,
      provider_subject: identity.provider_subject,
      username: identity.username,
    })),
  };
};

app.get('/internal/admin/users-overview', internalAuth, (_req, res) => {
  const total = Number((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count) || 0;
  const users = db.prepare(`
    SELECT
      u.id,
      u.name,
      u.role,
      u.is_admin,
      u.status,
      u.plan,
      u.weekly_tokens_used,
      u.weekly_tokens_quota,
      u.weekly_window_started_at,
      u.weekly_cost_used,
      u.weekly_cost_quota,
      u.language,
      u.created_at,
      COUNT(cm.id) AS message_count,
      MAX(cm.created_at) AS last_message_at,
      (
        SELECT SUM(COALESCE(utu.actual_cost_usd, utu.estimated_cost_usd, 0))
        FROM user_token_usage utu
        WHERE utu.user_id = u.id
      ) AS total_cost_usd
    FROM users u
    LEFT JOIN chat_messages cm ON cm.user_id = u.id
    GROUP BY u.id
    ORDER BY COALESCE(MAX(cm.created_at), u.created_at) DESC, u.id DESC
    LIMIT 500
  `).all() as Array<{
    id: number;
    name: string | null;
    role: string;
    is_admin: number;
    status: string;
    plan: string;
    weekly_tokens_used: number;
    weekly_tokens_quota: number;
    weekly_window_started_at: number;
    weekly_cost_used: number;
    weekly_cost_quota: number;
    language: string | null;
    created_at: string | null;
    message_count: number;
    last_message_at: string | null;
    total_cost_usd: number | null;
  }>;

  const planLimitsMap = loadPlanLimitsFromDb();

  const identitiesByAccount = new Map<number, Array<{
    provider: string;
    provider_subject: string;
    username: string | null;
  }>>();

  if (users.length > 0) {
    const placeholders = users.map(() => '?').join(', ');
    const identities = db.prepare(`
      SELECT account_id, provider, provider_subject, username
      FROM account_identities
      WHERE account_id IN (${placeholders})
      ORDER BY id ASC
    `).all(...users.map(user => user.id)) as Array<{
      account_id: number;
      provider: string;
      provider_subject: string;
      username: string | null;
    }>;

    for (const identity of identities) {
      const accountIdentities = identitiesByAccount.get(identity.account_id) || [];
      accountIdentities.push({
        provider: identity.provider,
        provider_subject: identity.provider_subject,
        username: identity.username,
      });
      identitiesByAccount.set(identity.account_id, accountIdentities);
    }
  }

  const now = Date.now();
  return res.json({
    users: users.map(user => {
      const client = wsClients.get(user.id);
      const desktopOnline = !!client
        && client.ws.readyState === WebSocket.OPEN
        && now - client.lastPongAt <= WS_HEARTBEAT_GRACE_MS;

      const planLimits = planLimitsMap[user.plan as keyof typeof planLimitsMap] ?? planLimitsMap.free;
      const isBudget = planLimits.billing_mode === 'budget';
      const quotaUsed = isBudget ? user.weekly_cost_used : user.weekly_tokens_used;
      const quotaTotal = isBudget ? user.weekly_cost_quota : user.weekly_tokens_quota;
      const quotaPercent = quotaTotal > 0
        ? Math.min(100, Math.round((Number(quotaUsed) || 0) / quotaTotal * 100))
        : 0;

      return {
        ...user,
        account_id: user.id,
        is_admin: user.is_admin === 1 || user.role === 'admin',
        message_count: Number(user.message_count) || 0,
        quota_percent: quotaPercent,
        identities: identitiesByAccount.get(user.id) || [],
        desktop: {
          online: desktopOnline,
          connected_at: client?.connectedAt ?? null,
          last_activity_at: client?.lastMessageAt ?? null,
        },
      };
    }),
    total,
    limited: total > users.length,
  });
});

app.get('/internal/admin/server-access-keys', internalAuth, (_req, res) => {
  return res.json({ keys: listServerAccessKeys(), enabled: isServerAccessKeyGateEnabled() });
});

app.post('/internal/admin/server-access-keys', internalAuth, (req, res) => {
  return res.status(201).json({ key: createServerAccessKey(`${req.body?.name || ''}`) });
});

app.delete('/internal/admin/server-access-keys/:id', internalAuth, (req, res) => {
  const keyId = Math.floor(Number(req.params.id));
  if (!Number.isFinite(keyId) || keyId <= 0) return res.status(400).json({ error: 'bad_key_id' });
  const result = revokeServerAccessKey(keyId);
  if (!result.changes) return res.status(404).json({ error: 'key_not_found' });
  return res.json({ ok: true });
});

app.get('/internal/admin/users-overview/:id', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = db.prepare(`
    SELECT
      id, name, role, is_admin, status, plan, language, created_at,
      daily_message_count,
      weekly_tokens_used, weekly_tokens_quota, weekly_window_started_at,
      weekly_cost_used, weekly_cost_quota, weekly_cost_quota_limit,
      daily_web_search_count, daily_web_search_limit, total_web_search_count,
      daily_image_gen_count, daily_image_gen_limit, total_image_gen_count,
      total_message_length, preferred_model, reasoning_level,
      max_context_tokens_limit, max_context_tokens, attachment_max_tokens
    FROM users
    WHERE id = ?
  `).get(userId) as Record<string, unknown> | undefined;
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  const messageStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages,
      SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages,
      MAX(created_at) AS last_message_at
    FROM chat_messages
    WHERE user_id = ?
  `).get(userId) as {
    total: number;
    user_messages: number;
    assistant_messages: number;
    last_message_at: string | null;
  };
  const chatCount = Number((db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id = ?').get(userId) as { count: number }).count) || 0;
  const totalCostRow = db.prepare(`
    SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) AS total_cost_usd
    FROM user_token_usage
    WHERE user_id = ?
  `).get(userId) as { total_cost_usd: number | null };
  const identities = db.prepare(`
    SELECT provider, provider_subject, username, created_at, updated_at
    FROM account_identities
    WHERE account_id = ?
    ORDER BY id ASC
  `).all(userId);
  const client = wsClients.get(userId);
  const desktopOnline = !!client
    && client.ws.readyState === WebSocket.OPEN
    && Date.now() - client.lastPongAt <= WS_HEARTBEAT_GRACE_MS;
  const subscription = db.prepare(`
    SELECT plan, started_at, ends_at
    FROM user_plan_subscriptions
    WHERE user_id = ? AND is_current = 1
    ORDER BY id DESC LIMIT 1
  `).get(userId) || null;

  return res.json({
    user: {
      ...user,
      is_admin: user.is_admin === 1 || user.role === 'admin',
      identities,
      messages: {
        total: Number(messageStats.total) || 0,
        user: Number(messageStats.user_messages) || 0,
        assistant: Number(messageStats.assistant_messages) || 0,
        last_message_at: messageStats.last_message_at,
      },
      chats_count: chatCount,
      total_cost_usd: Number(totalCostRow.total_cost_usd) || 0,
      ban: getBanRecord(userId) || null,
      subscription,
      last_server_access_key: getLastServerAccessKeyForUser(userId),
      desktop: {
        online: desktopOnline,
        connected_at: client?.connectedAt ?? null,
        last_activity_at: client?.lastMessageAt ?? null,
      },
    },
  });
});

app.get('/internal/users/by-telegram/:telegramId', internalAuth, (req, res) => {
  const telegramId = Math.floor(Number(req.params.telegramId));
  if (!Number.isFinite(telegramId) || telegramId <= 0) {
    return res.status(400).json({ error: 'bad_telegram_id' });
  }
  const accountId = getAccountIdByTelegramId(telegramId);
  if (!accountId) return res.status(404).json({ error: 'telegram_identity_not_found' });
  const user = getUserById(accountId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ user: withAccountIdentities(user) });
});

app.get('/internal/users/:id', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ user: withAccountIdentities(user) });
});

app.get('/internal/users/:id/prompt/resolved', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ prompt: resolveStoredPromptForUser(user) });
});

app.put('/internal/users/:id/language', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id || req.params.id);
  const language = normalizeSupportedLanguage(req.body?.language);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!language) {
    return res.status(400).json({
      error: 'unsupported_language',
      supported_languages: SUPPORTED_LANGUAGES,
    });
  }

  const result = db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
  if (result.changes === 0) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ ok: true, language });
});

app.put('/internal/users/:id/tg-username', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id || req.params.id);
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
    return res.json({ users: users.map(withAccountIdentities), total: count, filter, limit, offset });
  }

  if (filter === 'banned') {
    const count = getBannedUsersCount();
    const users = getBannedUsersPage(limit, offset);
    return res.json({ users: users.map(withAccountIdentities), total: count, filter, limit, offset });
  }

  const count = getUsersCount();
  const users = getUsersPage(limit, offset);
  return res.json({ users: users.map(withAccountIdentities), total: count, filter: 'all', limit, offset });
});

// ── Internal: User status/role/name management ────────────────────────────

app.put('/internal/users/:id/status', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const status = `${req.body?.status || ''}`.trim() as 'none' | 'approved' | 'disapproved' | 'banned';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['none', 'approved', 'disapproved', 'banned'].includes(status)) return res.status(400).json({ error: 'bad_status' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserStatus(userId, status);
  if (user.status !== status) {
    if (status === 'approved') queueUserMessengerNotification(userId, 'approved');
    if (status === 'disapproved') queueUserMessengerNotification(userId, 'rejected');
    if (status === 'banned') queueUserMessengerNotification(userId, 'banned');
  }
  return res.json({ ok: true, status });
});

app.put('/internal/users/:id/role', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const role = `${req.body?.role || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserRole(userId, role);
  return res.json({ ok: true, role });
});

app.put('/internal/users/:id/name', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const name = `${req.body?.name || ''}`.trim();
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserName(userId, name);
  return res.json({ ok: true, name });
});

app.delete('/internal/users/:id', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  if (user.role === 'admin') return res.status(422).json({ error: 'cannot_delete_admin' });

  removeUser(userId);
  return res.json({ ok: true });
});

// ── Internal: User plan management ────────────────────────────────────────

app.post('/internal/users/:id/plan', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const plan = `${req.body?.plan || ''}`.trim() as 'free' | 'standart' | 'pro';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['free', 'standart', 'pro'].includes(plan)) return res.status(400).json({ error: 'bad_plan' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  const recordSubscription = req.body?.record_subscription === true;
  const endsAtRaw = req.body?.ends_at;
  const endsAt = typeof endsAtRaw === 'string' && endsAtRaw.trim() ? endsAtRaw.trim() : null;
  const assignedByRaw = req.body?.assigned_by;
  const assignedBy = Number.isFinite(Number(assignedByRaw))
    ? resolveInternalAccountId(assignedByRaw)
    : null;

  db.transaction(() => {
    updateUserPlan(userId, plan);
    if (recordSubscription) {
      db.prepare('UPDATE user_plan_subscriptions SET is_current = 0 WHERE user_id = ? AND is_current = 1').run(userId);
      db.prepare(`
        INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current, assigned_by)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1, ?)
      `).run(userId, plan, endsAt, assignedBy);
    }
  })();
  return res.json({ ok: true, plan, ends_at: endsAt });
});

app.get('/internal/users/:id/subscription', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const subscription = db.prepare(`
    SELECT id, user_id, plan, started_at, ends_at, is_current, assigned_by
    FROM user_plan_subscriptions
    WHERE user_id = ? AND is_current = 1
    ORDER BY id DESC LIMIT 1
  `).get(userId) || null;
  return res.json({ subscription });
});

app.post('/internal/sync-plan-limits', internalAuth, (_req, res) => {
  syncAllUsersPlanLimits();
  return res.json({ ok: true });
});

// ── Internal: Ban management ──────────────────────────────────────────────

app.post('/internal/users/:id/ban', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  const reason = `${req.body?.reason || ''}`.trim() || 'Решение администратора';
  const bannedBy = resolveInternalAccountId(req.body?.banned_by) || 0;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  if (user.role === 'admin') return res.status(422).json({ error: 'cannot_ban_admin' });

  setBan(userId, bannedBy, reason);
  updateUserStatus(userId, 'banned');
  queueUserMessengerNotification(userId, 'banned', { reason });
  return res.json({ ok: true, reason });
});

app.delete('/internal/users/:id/ban', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  removeBan(userId);
  updateUserStatus(userId, 'none');
  if (user.status === 'banned') queueUserMessengerNotification(userId, 'unbanned');
  return res.json({ ok: true, status: 'none' });
});

// ── Internal: Admin generate new password ────────────────────────────────

app.post('/internal/admin/users/:id/generate-password', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  try {
    // Generate plaintext password and hash it here (single source of truth:
    // makePasswordHash from auth.js). The chats service only persists it.
    const plainPassword = crypto.randomBytes(12).toString('hex'); // 24-char hex
    const { salt, hash } = makePasswordHash(plainPassword);
    const result = adminApplyGeneratedPassword(userId, plainPassword, salt, hash);
    console.log(`[admin] Password generated for user ${userId}`);
    return res.json({ ok: true, new_password: result.new_password });
  } catch (error: any) {
    const code = error?.message || 'unknown_error';
    if (code === 'no_password_identity') {
      return res.status(400).json({ error: 'no_password_identity' });
    }
    console.error('[admin] generate-password failed:', error);
    return res.status(500).json({ error: 'password_generation_failed' });
  }
});

app.get('/internal/users/:id/ban', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const ban = getBanRecord(userId);
  return res.json({ ban: ban || null });
});

// ── Internal: User prompt management (for index.ts) ───────────────────────

app.post('/internal/users/:id/prompt/select', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
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
  const userId = resolveInternalAccountId(req.params.id);
  const content = `${req.body?.content || ''}`;
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserCustomPrompt(userId, content);
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
    return res.json({ users: users.map(withAccountIdentities), total: count, filter, limit, offset });
  }

  if (filter === 'banned') {
    const count = getBannedUsersCount();
    const users = getBannedUsersPage(limit, offset);
    return res.json({ users: users.map(withAccountIdentities), total: count, filter, limit, offset });
  }

  const count = getUsersCount();
  const users = getUsersPage(limit, offset);
  return res.json({ users: users.map(withAccountIdentities), total: count, filter: 'all', limit, offset });
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

  return res.json({ user: withAccountIdentities(user), ban });
});

app.put('/api/v1/admin/users/:id/status', adminMiddleware, async (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const status = `${req.body?.status || ''}`.trim() as 'none' | 'approved' | 'disapproved' | 'banned';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!['none', 'approved', 'disapproved', 'banned'].includes(status)) return res.status(400).json({ error: 'bad_status' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  updateUserStatus(userId, status);
  if (user.status !== status) {
    if (status === 'approved') queueUserMessengerNotification(userId, 'approved');
    if (status === 'disapproved') queueUserMessengerNotification(userId, 'rejected');
    if (status === 'banned') queueUserMessengerNotification(userId, 'banned');
  }
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

  if (user.role === 'admin') return res.status(422).json({ error: 'cannot_delete_admin' });

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

app.post('/api/v1/admin/users/:id/ban', adminMiddleware, async (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const reason = `${req.body?.reason || ''}`.trim() || 'Решение администратора';
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  if (user.role === 'admin') return res.status(422).json({ error: 'cannot_ban_admin' });

  setBan(userId, req.authUserId!, reason);
  updateUserStatus(userId, 'banned');
  queueUserMessengerNotification(userId, 'banned', { reason });
  return res.json({ ok: true, reason });
});

app.delete('/api/v1/admin/users/:id/ban', adminMiddleware, async (req: AuthedRequest, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  removeBan(userId);
  updateUserStatus(userId, 'none');
  if (user.status === 'banned') queueUserMessengerNotification(userId, 'unbanned');
  return res.json({ ok: true, status: 'none' });
});

// ─── Plan limits config (admin-editable) ────────────────────────────────────

app.post('/internal/admin/sync-plan-limits', internalAuth, (_req, res) => {
  syncAllUsersPlanLimits();
  return res.json({ ok: true });
});

app.get('/internal/admin/plan-limits', internalAuth, (_req, res) => {
  const limits = loadPlanLimitsFromDb();
  return res.json({ limits });
});

app.put('/internal/admin/plan-limits', internalAuth, (req, res) => {
  const body = req.body as { limits?: Record<string, unknown> } | null;
  if (!body || !body.limits || typeof body.limits !== 'object') {
    return res.status(400).json({ error: 'bad_limits_payload' });
  }
  // All three plans must be present in the payload; reject if any are missing
  // so that a partial save cannot silently drop configuration.
  const incoming = body.limits as Record<string, any>;
  const next = {} as Record<typeof PLAN_IDS[number], PlanLimits>;
  for (const plan of PLAN_IDS) {
    const entry = incoming[plan];
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ error: `missing_plan_${plan}` });
    }
    next[plan] = {
      daily_web_search_limit: Math.max(0, Math.floor(Number(entry.daily_web_search_limit) || 0)),
      daily_image_gen_limit: Math.max(0, Math.floor(Number(entry.daily_image_gen_limit) || 0)),
      image_attachments_allowed: Boolean(entry.image_attachments_allowed),
      max_context_tokens: Math.max(0, Math.floor(Number(entry.max_context_tokens) || 0)),
      weekly_token_quota: Math.max(0, Number(entry.weekly_token_quota) || 0),
      billing_mode: entry.billing_mode === 'budget' ? 'budget' : 'tokens',
      budget_usd: Math.max(0, Number(entry.budget_usd) || 0),
      subscription_price: Math.max(0, Number(entry.subscription_price) || 0),
    };
  }
  savePlanLimitsToDb(next);
  syncAllUsersPlanLimits();
  return res.json({ ok: true, limits: next });
});

// ── Admin: Server update preparation (drain active users) ──────────────────

// GET: poll current state
app.get('/internal/admin/update/prepare', internalAuth, (_req, res) => {
  return res.json(getUpdateState());
});

// POST: prepare / cancel / extend / force
app.post('/internal/admin/update/prepare', internalAuth, (req, res) => {
  const action = `${req.body?.action || ''}`.trim().toLowerCase();
  if (!['prepare', 'cancel', 'force'].includes(action)) {
    return res.status(400).json({ error: 'bad_action', action });
  }

  if (action === 'prepare') {
    setUpdatePrepare();
    return res.json(getUpdateState());
  }

  if (action === 'cancel') {
    clearUpdatePrepare();
    return res.json(getUpdateState());
  }

  // force: ONLY aborts active generations. Does NOT touch the flag.
  // The flag is set separately via 'prepare' action.
  const aborted = forceAbortActiveGenerations();
  return res.json({ ...getUpdateState(), aborted });
});

// ─── Weekly cost quota: per-user overrides & resets ──────────────────────────

app.put('/internal/admin/users/:id/weekly-cost-quota', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  const quota = Number(req.body?.quota);
  if (!Number.isFinite(quota) || quota < 0) return res.status(400).json({ error: 'bad_quota' });
  updateUserWeeklyCostQuota(userId, quota);
  return res.json({ ok: true, weekly_cost_quota: quota });
});

app.post('/internal/admin/users/:id/reset-weekly-usage', internalAuth, (req, res) => {
  const userId = resolveInternalAccountId(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  resetUserWeeklyUsage(userId);
  return res.json({ ok: true });
});

app.post('/internal/admin/users/reset-weekly-usage-all', internalAuth, (_req, res) => {
  const affected = resetAllUsersWeeklyUsage();
  return res.json({ ok: true, affected });
});

// ─── Model overrides (coefficients + provider info) ─────────────────────────

app.get('/internal/admin/model-coefficients', internalAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT model_id, coefficient, updated_at,
           provider_kind, openrouter_provider_slug, pricing_mode,
           input_price_per_million, output_price_per_million,
           cache_read_price_per_million, pricing_source, pricing_updated_at,
           selected_api_key_id, is_free
    FROM model_overrides
  `).all() as Array<ModelOverride>;
  const coefficients: Record<string, number> = {};
  const overrides: Record<string, {
    providerKind: ProviderKind;
    openrouterProviderSlug: string | null;
    pricingMode: PricingMode;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cacheReadPricePerMillion: number | null;
    pricingSource: string | null;
    pricingUpdatedAt: number | null;
    selectedApiKeyId: number | null;
    isFree: boolean;
  }> = {};
  for (const row of rows) {
    coefficients[row.model_id] = row.coefficient;
    overrides[row.model_id] = {
      providerKind: row.provider_kind,
      openrouterProviderSlug: row.openrouter_provider_slug,
      pricingMode: row.pricing_mode,
      inputPricePerMillion: row.input_price_per_million,
      outputPricePerMillion: row.output_price_per_million,
      cacheReadPricePerMillion: row.cache_read_price_per_million,
      pricingSource: row.pricing_source,
      pricingUpdatedAt: row.pricing_updated_at,
      selectedApiKeyId: row.selected_api_key_id,
      isFree: row.is_free === 1,
    };
  }
  return res.json({ coefficients, overrides });
});

app.put('/internal/admin/model-coefficients/:modelId', internalAuth, (req, res) => {
  const modelId = `${req.params.modelId || ''}`.trim();
  if (!modelId) return res.status(400).json({ error: 'bad_model_id' });
  const body = req.body as {
    coefficient?: number;
    providerKind?: ProviderKind;
    openrouterProviderSlug?: string | null;
    pricingMode?: PricingMode;
    inputPricePerMillion?: number | null;
    outputPricePerMillion?: number | null;
    cacheReadPricePerMillion?: number | null;
    pricingSource?: string | null;
    selectedApiKeyId?: number | null;
    isFree?: boolean | null;
  } | null;

  // Handle coefficient-only mode (backward-compatible).
  const rawCoeff = Number(body?.coefficient);
  const hasCoeff = body && 'coefficient' in body && Number.isFinite(rawCoeff);

  const hasProviderFields = body && (
    'providerKind' in body
    || 'openrouterProviderSlug' in body
    || 'pricingMode' in body
    || 'inputPricePerMillion' in body
    || 'outputPricePerMillion' in body
    || 'cacheReadPricePerMillion' in body
    || 'pricingSource' in body
    || 'selectedApiKeyId' in body
    || 'isFree' in body
  );

  if (hasProviderFields) {
    // Full override update
    setModelProvider(modelId, {
      providerKind: body?.providerKind,
      openrouterProviderSlug: body?.openrouterProviderSlug,
      pricingMode: body?.pricingMode,
      inputPricePerMillion: body?.inputPricePerMillion,
      outputPricePerMillion: body?.outputPricePerMillion,
      cacheReadPricePerMillion: body?.cacheReadPricePerMillion,
      pricingSource: body?.pricingSource,
      coefficient: hasCoeff && rawCoeff >= 0 ? rawCoeff : null,
      selectedApiKeyId: body?.selectedApiKeyId,
      isFree: body && 'isFree' in body ? Boolean(body.isFree) : null,
    });
    return res.json({ ok: true, model_id: modelId });
  }

  // Backward-compatible coefficient-only update
  if (!hasCoeff || rawCoeff < 0) return res.status(400).json({ error: 'bad_coefficient' });
  setCoefficient(modelId, rawCoeff);
  return res.json({ ok: true, model_id: modelId, coefficient: rawCoeff });
});

app.delete('/internal/admin/model-coefficients/:modelId', internalAuth, (req, res) => {
  const modelId = `${req.params.modelId || ''}`.trim();
  if (!modelId) return res.status(400).json({ error: 'bad_model_id' });
  db.prepare('DELETE FROM model_overrides WHERE model_id = ?').run(modelId);
  refreshCoefficientCache();
  return res.json({ ok: true });
});

// ─── Model billing info ─────────────────────────────────────────────────────

app.get('/internal/admin/models/:modelId/billing', internalAuth, (req, res) => {
  const modelId = `${req.params.modelId || ''}`.trim();
  if (!modelId) return res.status(400).json({ error: 'bad_model_id' });
  const override = getModelOverride(modelId);
  if (!override) return res.status(404).json({ error: 'model_override_not_found' });
  return res.json({
    modelId: override.model_id,
    coefficient: override.coefficient,
    providerKind: override.provider_kind,
    openrouterProviderSlug: override.openrouter_provider_slug,
    pricingMode: override.pricing_mode,
    inputPricePerMillion: override.input_price_per_million,
    outputPricePerMillion: override.output_price_per_million,
    cacheReadPricePerMillion: override.cache_read_price_per_million,
    pricingSource: override.pricing_source,
    pricingUpdatedAt: override.pricing_updated_at,
  });
});

app.put('/internal/admin/models/:modelId/billing', internalAuth, (req, res) => {
  const modelId = `${req.params.modelId || ''}`.trim();
  if (!modelId) return res.status(400).json({ error: 'bad_model_id' });
  const body = req.body as {
    providerKind?: ProviderKind;
    openrouterProviderSlug?: string | null;
    pricingMode?: PricingMode;
    inputPricePerMillion?: number | null;
    outputPricePerMillion?: number | null;
    cacheReadPricePerMillion?: number | null;
    coefficient?: number | null;
    selectedApiKeyId?: number | null;
    isFree?: boolean | null;
  } | null;
  if (!body) return res.status(400).json({ error: 'bad_body' });

  setModelProvider(modelId, {
    providerKind: body.providerKind,
    openrouterProviderSlug: body.openrouterProviderSlug,
    pricingMode: body.pricingMode || (body.inputPricePerMillion !== undefined ? 'manual' : undefined),
    inputPricePerMillion: body.inputPricePerMillion,
    outputPricePerMillion: body.outputPricePerMillion,
    cacheReadPricePerMillion: body.cacheReadPricePerMillion,
    pricingSource: body.pricingMode === 'auto' ? 'openrouter_auto' : 'manual',
    coefficient: body.coefficient,
    selectedApiKeyId: body.selectedApiKeyId,
    isFree: body.isFree,
  });
  return res.json({ ok: true, model_id: modelId });
});

// ─── API keys vault ──────────────────────────────────────────────────

app.get('/internal/admin/api-keys', internalAuth, async (req, res) => {
  try {
    const keys = db.prepare('SELECT id, name, key_prefix, created_at, updated_at FROM api_keys ORDER BY id ASC').all();
    res.json(keys);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'internal_error' });
  }
});

app.get('/internal/admin/api-keys/:id', internalAuth, async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(req.params.id)) as any;
    if (!row) return res.status(404).json({ error: 'api_key_not_found' });
    const parts = row.key_encrypted.split('::');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
    res.json({ id: row.id, name: row.name, key: decrypted, key_prefix: row.key_prefix, created_at: row.created_at, updated_at: row.updated_at });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'internal_error' });
  }
});

app.post('/internal/admin/api-keys', internalAuth, async (req, res) => {
  try {
    const { name, key } = req.body || {};
    if (!name?.trim() || !key?.trim()) return res.status(400).json({ error: 'name_and_key_required' });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
    const encrypted = Buffer.concat([cipher.update(key.trim(), 'utf8'), cipher.final()]);
    const key_encrypted = `${iv.toString('hex')}::${encrypted.toString('hex')}`;
    const trimmed = key.trim();
    const key_prefix = trimmed.length > 12
      ? `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`
      : trimmed.length > 4
        ? `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`
        : trimmed;
    const result = db.prepare('INSERT INTO api_keys (name, key_encrypted, key_prefix) VALUES (?, ?, ?)').run(name.trim(), key_encrypted, key_prefix);
    const created = db.prepare('SELECT id, name, key_prefix, created_at, updated_at FROM api_keys WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'internal_error' });
  }
});

app.get('/internal/admin/api-keys/:id/used-by', internalAuth, async (req, res) => {
  try {
    const keyId = Number(req.params.id);
    const models = db.prepare(
      'SELECT model_id FROM model_overrides WHERE selected_api_key_id = ?'
    ).all(keyId) as Array<{ model_id: string }>;
    res.json({ models: models.map(m => m.model_id) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'internal_error' });
  }
});

app.delete('/internal/admin/api-keys/:id', internalAuth, async (req, res) => {
  try {
    const keyId = Number(req.params.id);
    const exists = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(keyId);
    if (!exists) return res.status(404).json({ error: 'api_key_not_found' });

    const body = (req as any).body || {};
    const replacementKeyId = body.replacementKeyId;

    // Validate replacement key (must exist and not be the same key being deleted)
    const replacementIdNum = replacementKeyId !== null && replacementKeyId !== undefined
      ? Number(replacementKeyId)
      : null;
    if (replacementIdNum !== null) {
      if (!Number.isFinite(replacementIdNum) || replacementIdNum <= 0) {
        return res.status(400).json({ error: 'invalid_replacement_key_id' });
      }
      if (replacementIdNum === keyId) {
        return res.status(400).json({ error: 'cannot_replace_with_self' });
      }
      const replacementExists = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(replacementIdNum);
      if (!replacementExists) {
        return res.status(400).json({ error: 'replacement_key_not_found' });
      }
    }

    // Atomic: reassign/nullify references and delete the key in a single tx
    const tx = db.transaction(() => {
      if (replacementIdNum === null) {
        db.prepare('UPDATE model_overrides SET selected_api_key_id = NULL WHERE selected_api_key_id = ?').run(keyId);
      } else {
        db.prepare('UPDATE model_overrides SET selected_api_key_id = ? WHERE selected_api_key_id = ?').run(replacementIdNum, keyId);
      }
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
    });
    tx();
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'internal_error' });
  }
});


// ─── User usage (stats for admin UI) ────────────────────────────────────────

app.get('/internal/admin/users/:id/usage', internalAuth, (req, res) => {
  const userId = resolveAccountId(Number(req.params.id));
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const user = db.prepare(`
    SELECT id, plan, weekly_tokens_used, weekly_tokens_quota, weekly_window_started_at
    FROM users WHERE id = ?
  `).get(userId) as { id: number; plan: string; weekly_tokens_used: number; weekly_tokens_quota: number; weekly_window_started_at: number } | undefined;
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  const now = Math.floor(Date.now() / 1000);
  const windowStart = user.weekly_window_started_at || now;
  const windowEnd = windowStart + 7 * 24 * 60 * 60;

  // Aggregate by model_id (all-time for stats honesty; window is for current quota).
  const byModel = db.prepare(`
    SELECT
      model_id,
      MAX(model_name) AS model_name,
      route,
      MAX(provider_name) AS provider_name,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(cache_hit_tokens) AS cache_hit_tokens,
      SUM(cache_miss_tokens) AS cache_miss_tokens,
      SUM(reasoning_tokens) AS reasoning_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(charged_tokens) AS charged_tokens,
      SUM(CASE WHEN charged_tokens = 0 THEN 1 ELSE 0 END) AS free_requests,
      SUM(CASE WHEN aborted = 1 THEN 1 ELSE 0 END) AS aborted_requests,
      SUM(estimated_cost_usd) AS estimated_cost_usd,
      SUM(actual_cost_usd) AS actual_cost_usd,
      COUNT(*) AS request_count
    FROM user_token_usage
    WHERE user_id = ? AND created_at >= ?
    GROUP BY model_id, route
    ORDER BY SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) DESC
  `).all(userId, windowStart) as Array<{
    model_id: string | null;
    model_name: string | null;
    route: string | null;
    provider_name: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    charged_tokens: number;
    free_requests: number;
    aborted_requests: number;
    estimated_cost_usd: number | null;
    actual_cost_usd: number | null;
    request_count: number;
  }>;

  return res.json({
    user: {
      id: user.id,
      plan: user.plan,
      weekly_tokens_used: user.weekly_tokens_used || 0,
      weekly_tokens_quota: user.weekly_tokens_quota || 0,
      weekly_window_started_at: windowStart,
      weekly_window_ends_at: windowEnd,
    },
    by_model: byModel,
  });
});

// ── Admin Update Manager ───────────────────────────────────────────────────


// ─── Models catalog & preferred model ────────────────────────────────────────

app.get('/api/v1/models', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  const catalog = getModelsCatalog(user?.is_admin === 1);
  return res.json({
    models: catalog,
    preferred_model: user?.preferred_model || null,
    auto_reasoning_levels: getAutoReasoningLevels(),
    auto_supports_vision: getAutoVisionSupport(),
  });
});

app.put('/api/v1/user/preferred-model', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const modelId = req.body?.model_id ?? null; // null = auto
  if (modelId !== null && typeof modelId !== 'string') {
    return res.status(400).json({ error: 'bad_model_id' });
  }
  // Валидация: если не null, модель должна быть в каталоге
  if (modelId !== null) {
    const user = getUserById(userId);
    const catalog = getModelsCatalog(user?.is_admin === 1);
    if (!catalog.some(m => m.id === modelId)) {
      return res.status(400).json({ error: 'model_not_found' });
    }
  }
  db.prepare('UPDATE users SET preferred_model = ? WHERE id = ?').run(modelId, userId);
  return res.json({ ok: true, preferred_model: modelId });
});

// ─── Subagent preferred model ───────────────────────────────────────────────

app.get('/api/v1/user/subagent-model', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  return res.json({ subagent_model: user?.subagent_mode && user.subagent_mode !== 'auto' ? user.subagent_mode : null });
});

app.put('/api/v1/user/subagent-model', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const modelId = req.body?.model_id ?? null;
  if (modelId !== null && typeof modelId !== 'string') {
    return res.status(400).json({ error: 'bad_model_id' });
  }
  if (modelId !== null) {
    const user = getUserById(userId);
    const catalog = getModelsCatalog(user?.is_admin === 1);
    if (!catalog.some(m => m.id === modelId)) {
      return res.status(400).json({ error: 'model_not_found' });
    }
  }
  db.prepare('UPDATE users SET subagent_mode = ? WHERE id = ?').run(modelId || 'auto', userId);
  return res.json({ ok: true, subagent_model: modelId });
});

// ─── Reasoning level ────────────────────────────────────────────────────────

const VALID_REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

app.get('/api/v1/user/reasoning-level', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  return res.json({ reasoning_level: user?.reasoning_level || null });
});

app.put('/api/v1/user/reasoning-level', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const level = req.body?.reasoning_level ?? null;
  if (level !== null) {
    if (typeof level !== 'string' || !VALID_REASONING_LEVELS.includes(level as any)) {
      return res.status(400).json({ error: 'bad_reasoning_level' });
    }
  }
  db.prepare('UPDATE users SET reasoning_level = ? WHERE id = ?').run(level, userId);
  return res.json({ ok: true, reasoning_level: level });
});

app.get('/api/v1/user/subagent-reasoning-level', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  return res.json({ reasoning_level: user?.subagent_reasoning_level || null });
});

app.put('/api/v1/user/subagent-reasoning-level', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const level = req.body?.reasoning_level ?? null;
  if (level !== null) {
    if (typeof level !== 'string' || !VALID_REASONING_LEVELS.includes(level as any)) {
      return res.status(400).json({ error: 'bad_reasoning_level' });
    }
  }
  db.prepare('UPDATE users SET subagent_reasoning_level = ? WHERE id = ?').run(level, userId);
  return res.json({ ok: true, reasoning_level: level });
});

// ─── Model settings (temperature, penalties, etc.) ─────────────────────────

/**
 * Schema for per-model generation settings.
 * Каждое поле опционально. Если поле отсутствует или null — используется серверный дефолт.
 * Хранится в users.model_settings как JSON: { "model_id": { temperature: 0.7, ... } }
 */
const MODEL_SETTINGS_RANGES: Record<string, { min: number; max: number; step: number }> = {
  temperature:        { min: 0.0, max: 2.0,    step: 0.05 },
  top_p:              { min: 0.0, max: 1.0,    step: 0.05 },
  top_k:              { min: 1,   max: 100,    step: 1 },
  frequency_penalty:  { min: -2.0, max: 2.0,   step: 0.05 },
  presence_penalty:   { min: -2.0, max: 2.0,   step: 0.05 },
  repetition_penalty: { min: 1.0, max: 2.0,    step: 0.05 },
  max_tokens:         { min: 1,   max: 65536,  step: 1 },
};

const parseModelSettings = (raw: string | null | undefined): Record<string, any> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
};

app.get('/api/v1/user/model-settings', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  const settings = parseModelSettings(user?.model_settings);
  return res.json({ model_settings: settings });
});

app.put('/api/v1/user/model-settings', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  const modelId = req.body?.model_id;
  const incoming = req.body?.settings;

  if (typeof modelId !== 'string' || !modelId.trim()) {
    return res.status(400).json({ error: 'bad_model_id' });
  }
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'bad_settings' });
  }

  // Валидация: оставляем только разрешённые ключи с корректными значениями
  const cleaned: Record<string, number> = {};
  for (const [key, rawVal] of Object.entries(incoming)) {
    const range = MODEL_SETTINGS_RANGES[key];
    if (!range) continue; // неизвестный параметр — отбрасываем
    if (rawVal === null || rawVal === undefined) continue; // null = удалить параметр
    const num = Number(rawVal);
    if (!Number.isFinite(num)) {
      return res.status(400).json({ error: `bad_${key}` });
    }
    if (num < range.min || num > range.max) {
      return res.status(400).json({ error: `${key}_out_of_range` });
    }
    // Округляем до step
    const rounded = Math.round(num / range.step) * range.step;
    cleaned[key] = Math.max(range.min, Math.min(range.max, Number(rounded.toFixed(4))));
  }

  const current = parseModelSettings(user.model_settings);
  current[modelId] = cleaned;
  db.prepare('UPDATE users SET model_settings = ? WHERE id = ?').run(JSON.stringify(current), userId);
  return res.json({ ok: true, model_settings: current });
});

app.delete('/api/v1/user/model-settings/:modelId', (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  const modelId = req.params.modelId;
  const current = parseModelSettings(user.model_settings);
  if (!(modelId in current)) {
    return res.json({ ok: true, model_settings: current });
  }
  delete current[modelId];
  db.prepare('UPDATE users SET model_settings = ? WHERE id = ?').run(JSON.stringify(current), userId);
  return res.json({ ok: true, model_settings: current });
});

// ─── Feature flags (tool restrictions) ──────────────────────────────────────

const VALID_FLAG_KEYS = ['disable_memory_write', 'disable_pc_control_lite', 'disable_pc_control_full', 'disable_pc_commands', 'disable_internet', 'disable_personal', 'disable_specialized_subagents', 'disable_adhoc_subagents'] as const;

app.get('/api/v1/user/feature-flags', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const flags: Record<string, boolean> = {};
  try {
    const raw = JSON.parse(user.feature_flags || '{}');
    for (const key of VALID_FLAG_KEYS) {
      flags[key] = Boolean(raw[key]);
    }
  } catch { /* defaults all false */ }
  return res.json({ flags });
});

app.put('/api/v1/user/feature-flags', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const incoming = req.body?.flags;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'bad_flags' });
  }
  const flags: Record<string, boolean> = {};
  for (const key of VALID_FLAG_KEYS) {
    flags[key] = Boolean(incoming[key]);
  }
  db.prepare('UPDATE users SET feature_flags = ? WHERE id = ?').run(JSON.stringify(flags), userId);
  return res.json({ ok: true, flags });
});

// ─── UI settings (display options stored per user) ──────────────────────────

const VALID_UI_KEYS = ['show_tokens', 'dice_roll_enabled', 'seen_announcements'] as const;

type UiSettingValue = boolean | string[];

/** Преобразует dice_mode из body запроса в форсированное значение d20. */
const resolveDiceForceValue = (mode: unknown): number | undefined => {
  if (mode === 'always_one') return 1;
  if (mode === 'always_twenty') return 20;
  return undefined; // 'normal' или невалидное — случайный бросок
};

const isValidUiValue = (key: string, value: unknown): value is UiSettingValue => {
  if (key === 'seen_announcements') {
    return Array.isArray(value) && value.every((v: unknown) => typeof v === 'string');
  }
  return typeof value === 'boolean';
};

app.get('/api/v1/user/ui-settings', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const settings: Record<string, UiSettingValue> = { show_tokens: true, dice_roll_enabled: false, seen_announcements: [] };
  try {
    const raw = JSON.parse(user.ui_settings || '{}');
    for (const key of VALID_UI_KEYS) {
      if (key in raw && isValidUiValue(key, raw[key])) settings[key] = raw[key];
    }
  } catch { /* defaults */ }
  return res.json({ settings });
});

app.put('/api/v1/user/ui-settings', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const incoming = req.body?.settings;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'bad_settings' });
  }
  // load-merge: читаем существующие и мержим только валидные ключи
  const user = getUserById(userId);
  const existing: Record<string, UiSettingValue> = {};
  try {
    const raw = JSON.parse(user?.ui_settings || '{}');
    for (const key of VALID_UI_KEYS) {
      if (key in raw && isValidUiValue(key, raw[key])) existing[key] = raw[key];
    }
  } catch { /* empty */ }
  for (const key of VALID_UI_KEYS) {
    if (key in incoming && isValidUiValue(key, incoming[key])) existing[key] = incoming[key];
  }
  db.prepare('UPDATE users SET ui_settings = ? WHERE id = ?').run(JSON.stringify(existing), userId);
  return res.json({ ok: true, settings: existing });
});

// ─── Context Token Limit ────────────────────────────────────────────────────

app.get('/api/v1/user/context-tokens-limit', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({
    max_context_tokens: resolveMaxContextTokens(user),
    max_context_tokens_limit: user.max_context_tokens_limit || 30000,
  });
});

app.put('/api/v1/user/context-tokens-limit', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const requested = Number(req.body?.max_context_tokens);
  if (!Number.isFinite(requested) || requested < 1000) return res.status(400).json({ error: 'bad_max_context_tokens' });
  const hardLimit = Number.isFinite(user.max_context_tokens_limit) && user.max_context_tokens_limit! > 0
    ? Math.floor(user.max_context_tokens_limit!) : 30000;
  const clamped = Math.min(Math.floor(requested), hardLimit);
  updateUserMaxContextTokens(userId, clamped);
  return res.json({ ok: true, max_context_tokens: clamped, max_context_tokens_limit: hardLimit });
});

// ─── Attachment tokens limit (documents injection budget) ────────────────────

app.get('/api/v1/user/attachment-tokens-limit', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const maxCtx = resolveMaxContextTokens(user);
  const hardCap = Math.floor(maxCtx * 0.9);
  return res.json({
    attachment_max_tokens: resolveAttachmentMaxTokens(user),
    attachment_max_tokens_limit: hardCap,
    max_context_tokens: maxCtx,
  });
});

app.put('/api/v1/user/attachment-tokens-limit', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const requested = Number(req.body?.attachment_max_tokens);
  // 0 = auto (90% of max_context_tokens)
  if (!Number.isFinite(requested) || requested < 0) return res.status(400).json({ error: 'bad_attachment_max_tokens' });
  const maxCtx = resolveMaxContextTokens(user);
  const hardCap = Math.floor(maxCtx * 0.9);
  const clamped = Math.min(Math.floor(requested), hardCap);
  updateUserAttachmentMaxTokens(userId, clamped);
  return res.json({ ok: true, attachment_max_tokens: clamped, attachment_max_tokens_limit: hardCap });
});

// ─── Macros CRUD ────────────────────────────────────────────────────────────

app.get('/api/v1/macros', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  return res.json({ macros: listMacros(userId) });
});

app.post('/api/v1/macros', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
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
  const userId = accountIdFromRequest(req);
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
  const userId = accountIdFromRequest(req);
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
    console.error('[macro/explain]', formatSafeError(err));
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
    console.error('[macro/describe]', formatSafeError(err));
    return res.status(500).json({ error: 'ai_call_failed' });
  }
});

// ─── DevOps: Pending confirmations (shared with ai.ts) ─────────────────────
// (handled by services/devops-confirmations.ts — auto-cleanup included)

// ─── DevOps Servers CRUD ────────────────────────────────────────────────────

app.get('/api/v1/devops/servers', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  return res.json({ servers: listServers(userId) });
});

app.get('/api/v1/devops/servers/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const server = getServerById(userId, serverId);
  if (!server) return res.status(404).json({ error: 'not_found' });
  return res.json({ server });
});

app.post('/api/v1/devops/servers', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const name = `${req.body?.name || ''}`;
  const host = `${req.body?.host || ''}`;
  const port = Number(req.body?.port || 22);
  const username = `${req.body?.username || ''}`;
  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
  const privateKey = typeof req.body?.private_key === 'string' ? req.body.private_key : undefined;
  const sudoPassword = typeof req.body?.sudo_password === 'string' ? req.body.sudo_password : undefined;
  const defaultSshKeyId = req.body?.default_ssh_key_id ? Number(req.body.default_ssh_key_id) : null;
  const useSshKeyForLogin = req.body?.use_ssh_key_for_login === true;
  const autoApproveAll = req.body?.auto_approve_all === true;

  const result = createServer(userId, name, host, port, username, password, privateKey, sudoPassword, defaultSshKeyId, useSshKeyForLogin, autoApproveAll);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'name_required' || code === 'host_required' || code === 'username_required' || code === 'invalid_port' || code === 'auth_required' || code === 'invalid_ssh_key' || code === 'ssh_key_required' || code === 'ssh_private_key_required') return res.status(400).json({ error: code });
    if (code === 'servers_limit') return res.status(429).json({ error: code });
    return res.status(422).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.put('/api/v1/devops/servers/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const updates: Record<string, unknown> = {};
  if (req.body?.name !== undefined) updates.name = `${req.body.name}`;
  if (req.body?.host !== undefined) updates.host = `${req.body.host}`;
  if (req.body?.port !== undefined) updates.port = Number(req.body.port);
  if (req.body?.username !== undefined) updates.username = `${req.body.username}`;
  if (req.body?.password !== undefined) updates.password = `${req.body.password}`;
  if (req.body?.private_key !== undefined) updates.privateKey = `${req.body.private_key}`;
  if (req.body?.sudo_password !== undefined) updates.sudoPassword = `${req.body.sudo_password}`;
  if (req.body?.default_ssh_key_id !== undefined) {
    const v = req.body.default_ssh_key_id;
    updates.defaultSshKeyId = v === null || v === '' ? null : Number(v);
  }
  if (req.body?.use_ssh_key_for_login !== undefined) updates.useSshKeyForLogin = req.body.use_ssh_key_for_login === true;
  if (req.body?.auto_approve_all !== undefined) updates.autoApproveAll = req.body.auto_approve_all === true;

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  const result = updateServer(userId, serverId, updates);
  if (!result.ok) {
    const err = (result as { ok: false; error: string }).error;
    if (err === 'not_found') return res.status(404).json({ error: err });
    return res.status(422).json({ error: err });
  }
  return res.json({ ok: true });
});

app.delete('/api/v1/devops/servers/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const deleted = deleteServer(userId, serverId);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

// ─── DevOps: Test SSH connection ────────────────────────────────────────────

app.post('/api/v1/devops/servers/:id/test', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const server = getServerById(userId, serverId);
  if (!server) return res.status(404).json({ error: 'not_found' });

  try {
    const result = await testSshConnection(userId, serverId);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'ssh_test_failed', details: err?.message });
  }
});

// ─── DevOps: Execute command (manual, from desktop) ─────────────────────────

app.post('/api/v1/devops/servers/:id/exec', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const command = `${req.body?.command || ''}`.trim();
  if (!command) return res.status(400).json({ error: 'command_required' });

  const server = getServerById(userId, serverId);
  if (!server) return res.status(404).json({ error: 'not_found' });

  try {
    const result = await execSshCommand(userId, serverId, command);
    return res.json(result);
  } catch (err: any) {
    if (err?.message === 'command_blocked_dangerous') return res.status(403).json({ error: 'command_blocked_dangerous' });
    if (err?.message === 'server_not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'ssh_exec_failed', details: err?.message });
  }
});

// ─── DevOps Policies CRUD ───────────────────────────────────────────────────

app.get('/api/v1/devops/servers/:id/policies', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  return res.json({ policies: listPolicies(userId, serverId) });
});

app.post('/api/v1/devops/servers/:id/policies', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const pattern = `${req.body?.pattern || ''}`;
  const autoApprove = req.body?.auto_approve === true;

  const result = createPolicy(userId, serverId, pattern, autoApprove);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'not_found') return res.status(404).json({ error: code });
    return res.status(400).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.delete('/api/v1/devops/policies/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const policyId = Number(req.params.id);
  if (!Number.isFinite(policyId)) return res.status(400).json({ error: 'invalid_id' });

  const deleted = deletePolicy(userId, policyId);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

// ─── DevOps Runbooks CRUD ───────────────────────────────────────────────────

app.get('/api/v1/devops/runbooks', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  return res.json({ runbooks: listRunbooks(userId) });
});

app.get('/api/v1/devops/runbooks/public', (_req: AuthedRequest, res: any) => {
  return res.json({ runbooks: listPublicRunbooks() });
});

app.get('/api/v1/devops/runbooks/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const runbookId = Number(req.params.id);
  if (!Number.isFinite(runbookId)) return res.status(400).json({ error: 'invalid_id' });

  const runbook = getRunbookById(userId, runbookId);
  if (!runbook) return res.status(404).json({ error: 'not_found' });
  return res.json({ runbook });
});

app.post('/api/v1/devops/runbooks', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const title = `${req.body?.title || ''}`;
  const content = `${req.body?.content || ''}`;
  const commands: string[] = Array.isArray(req.body?.commands) ? req.body.commands.filter((c: unknown) => typeof c === 'string') : [];

  const result = createRunbook(userId, title, content, commands);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'title_required' || code === 'content_required') return res.status(400).json({ error: code });
    if (code === 'runbooks_limit') return res.status(429).json({ error: code });
    return res.status(422).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.put('/api/v1/devops/runbooks/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const runbookId = Number(req.params.id);
  if (!Number.isFinite(runbookId)) return res.status(400).json({ error: 'invalid_id' });

  const updates: Record<string, any> = {};
  if (req.body?.title !== undefined) updates.title = `${req.body.title}`;
  if (req.body?.content !== undefined) updates.content = `${req.body.content}`;
  if (Array.isArray(req.body?.commands)) updates.commands = req.body.commands.filter((c: unknown) => typeof c === 'string');

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  const result = updateRunbook(userId, runbookId, updates);
  if (!result.ok) {
    const err = (result as { ok: false; error: string }).error;
    if (err === 'not_found') return res.status(404).json({ error: err });
    return res.status(422).json({ error: err });
  }
  return res.json({ ok: true });
});

app.delete('/api/v1/devops/runbooks/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const runbookId = Number(req.params.id);
  if (!Number.isFinite(runbookId)) return res.status(400).json({ error: 'invalid_id' });

  const deleted = deleteRunbook(userId, runbookId);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

// ─── DevOps: Public Runbooks (shared by admins) ──────────────────────────────

app.post('/api/v1/devops/runbooks/public', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user || user.is_admin !== 1) return res.status(403).json({ error: 'forbidden_admin_only' });

  const title = `${req.body?.title || ''}`;
  const content = `${req.body?.content || ''}`;
  const commands: string[] = Array.isArray(req.body?.commands) ? req.body.commands.filter((c: unknown) => typeof c === 'string') : [];

  const result = createPublicRunbook(userId, user.name || '', title, content, commands);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'title_required' || code === 'content_required') return res.status(400).json({ error: code });
    return res.status(422).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.put('/api/v1/devops/runbooks/public/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user || user.is_admin !== 1) return res.status(403).json({ error: 'forbidden_admin_only' });

  const runbookId = Number(req.params.id);
  if (!Number.isFinite(runbookId)) return res.status(400).json({ error: 'invalid_id' });

  const updates: Record<string, any> = {};
  if (req.body?.title !== undefined) updates.title = `${req.body.title}`;
  if (req.body?.content !== undefined) updates.content = `${req.body.content}`;
  if (Array.isArray(req.body?.commands)) updates.commands = req.body.commands.filter((c: unknown) => typeof c === 'string');

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  const result = updatePublicRunbook(runbookId, updates);
  if (!result.ok) {
    const err = (result as { ok: false; error: string }).error;
    if (err === 'not_found') return res.status(404).json({ error: err });
    return res.status(422).json({ error: err });
  }
  return res.json({ ok: true });
});

app.delete('/api/v1/devops/runbooks/public/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const user = getUserById(userId);
  if (!user || user.is_admin !== 1) return res.status(403).json({ error: 'forbidden_admin_only' });

  const runbookId = Number(req.params.id);
  if (!Number.isFinite(runbookId)) return res.status(400).json({ error: 'invalid_id' });

  const deleted = deletePublicRunbook(runbookId);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

app.post('/api/v1/devops/runbooks/public/:id/save', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const publicId = Number(req.params.id);
  if (!Number.isFinite(publicId)) return res.status(400).json({ error: 'invalid_id' });

  const publicRunbook = getPublicRunbookById(publicId);
  if (!publicRunbook) return res.status(404).json({ error: 'not_found' });

  const result = createRunbook(userId, publicRunbook.title, publicRunbook.content, publicRunbook.commands);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'runbooks_limit') return res.status(429).json({ error: code });
    return res.status(422).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

// ─── DevOps: Attach runbook to server (creates auto-approve policies) ────────

app.post('/api/v1/devops/servers/:id/attach-runbook', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const serverId = Number(req.params.id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });

  const runbookId = Number(req.body?.runbook_id);
  if (!Number.isFinite(runbookId)) return res.status(400).json({ error: 'runbook_id_required' });

  const result = attachRunbookToServer(userId, serverId, runbookId);
  if (!result.ok) {
    const err = (result as { ok: false; error: string }).error;
    if (err === 'server_not_found' || err === 'runbook_not_found') return res.status(404).json({ error: err });
    return res.status(422).json({ error: err });
  }
  return res.json({ ok: true, created: (result as { ok: true; created: number }).created });
});

// ─── DevOps: AI extract commands from runbook text ───────────────────────────

app.post('/api/v1/devops/runbooks/extract-commands', async (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const content = `${req.body?.content || ''}`.trim();
  if (!content) return res.status(400).json({ error: 'content_required' });

  try {
    const text = await callLiteAi(
      'Ты — системный администратор. Извлеки все shell-команды из текста инструкции. Верни СТРОГО JSON-массив строк: ["command1", "command2"]. Без markdown, без пояснений, только JSON. Каждая команда — готовая к выполнению в терминале Linux.',
      content
    );
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      const commands: string[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      return res.json({ commands: commands.filter(c => typeof c === 'string' && c.trim()) });
    } catch {
      return res.json({ commands: [] });
    }
  } catch (err) {
    console.error('[runbooks/extract-commands]', formatSafeError(err));
    return res.status(500).json({ error: 'ai_call_failed' });
  }
});

app.post('/api/v1/devops/runbooks/review-commands', async (req: AuthedRequest, res) => {
  const userId = accountIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const commands: string[] = req.body?.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    return res.status(400).json({ error: 'commands_required' });
  }

  try {
    const user = getUserById(userId);
    const cmdList = commands.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const systemPrompt = translateForLanguage(user?.language, 'confirmations.reviewCommandsSystem', { language: normalizeSupportedLanguage(user?.language) || 'English' });
    const verdict = await callLiteAi(
      systemPrompt,
      cmdList
    );
    return res.json({ verdict });
  } catch (err) {
    console.error('[runbooks/review-commands]', formatSafeError(err));
    return res.status(500).json({ error: 'ai_call_failed' });
  }
});

// ── SSH Keys ──────────────────────────────────────────────────────────────

app.get('/api/v1/devops/ssh-keys', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const keys = listSshKeys(userId);
  return res.json({ keys });
});

app.post('/api/v1/devops/ssh-keys', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const name = `${req.body?.name || ''}`;
  const publicKey = `${req.body?.public_key || ''}`;
  const privateKey = req.body?.private_key ? `${req.body.private_key}` : undefined;

  const result = createSshKey(userId, name, publicKey, privateKey);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    return res.status(400).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.delete('/api/v1/devops/ssh-keys/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const keyId = Number(req.params.id);
  if (!Number.isFinite(keyId)) return res.status(400).json({ error: 'invalid_id' });

  const ok = deleteSshKey(userId, keyId);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

// ── Smart Home ─────────────────────────────────────────────────────────────

// ── Mail accounts ─────────────────────────────────────────────────────────

app.get('/api/v1/mail/accounts', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  return res.json(getMailAccountsPayload(userId));
});

app.post('/api/v1/mail/accounts', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const provider = normalizeMailProvider(req.body?.provider);
  const email = `${req.body?.email || ''}`.trim();
  const appPassword = `${req.body?.app_password || ''}`;

  if (!provider) return res.status(400).json({ error: 'bad_provider' });
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!appPassword) return res.status(400).json({ error: 'app_password_required' });

  try {
    const payload = await setupMailAccount(userId, provider, email, appPassword, req.body);
    return res.status(201).json(payload);
  } catch (err: any) {
    const code = `${err?.message || 'mail_setup_failed'}`;
    if (['bad_email', 'app_password_required', 'bad_provider', 'bad_mail_host', 'private_mail_host_forbidden', 'mail_login_required'].includes(code)) return res.status(400).json({ error: code });
    if (['mail_auth_failed', 'mail_smtp_auth_failed'].includes(code)) return res.status(401).json({ error: code });
    if (code === 'mail_runtime_unavailable') return res.status(503).json({ error: code });
    if (['mail_connection_failed', 'mail_smtp_connection_failed'].includes(code)) return res.status(502).json({ error: code });
    return res.status(500).json({ error: 'mail_setup_failed' });
  }
});

app.post('/api/v1/mail/accounts/:id/activate', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const accountId = Math.floor(Number(req.params.id));
  if (!Number.isFinite(accountId) || accountId <= 0) return res.status(400).json({ error: 'bad_mail_account_id' });

  const account = getMailAccountById(userId, accountId);
  if (!account) return res.status(404).json({ error: 'mail_account_not_found' });

  setActiveMailAccount(userId, account);
  return res.json(getMailAccountsPayload(userId));
});

app.delete('/api/v1/mail/accounts/:id', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const accountId = Math.floor(Number(req.params.id));
  if (!Number.isFinite(accountId) || accountId <= 0) return res.status(400).json({ error: 'bad_mail_account_id' });

  try {
    return res.json(removeMailAccount(userId, accountId));
  } catch (err: any) {
    if (err?.message === 'mail_account_not_found') return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: 'mail_account_delete_failed' });
  }
});

app.get('/api/v1/smart-home/settings', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const settings = getSmartHomeSettings(userId);
  return res.json({ settings });
});

app.get('/api/v1/smart-home/devices', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const devices = listSmartDevices(userId);
  return res.json({ devices });
});

// ── Yandex token ──
app.post('/api/v1/smart-home/token', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ error: 'token_required' });
  setSmartHomeToken(userId, token);
  return res.json({ ok: true });
});

app.delete('/api/v1/smart-home/token', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  deleteSmartHomeToken(userId);
  return res.json({ ok: true });
});

// ── Zigbee (MQTT) token ──
app.post('/api/v1/smart-home/zigbee/token', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const brokerUrl = typeof req.body?.broker_url === 'string' ? req.body.broker_url.trim() : '';
  if (!brokerUrl) return res.status(400).json({ error: 'broker_url_required' });
  // Basic Url validation
  if (!/^mqtt(s)?:\/\/.+/.test(brokerUrl) && !/^wss?:\/\/.+/.test(brokerUrl)) {
    return res.status(400).json({ error: 'invalid_broker_url', message: 'URL must start with mqtt://, mqtts://, ws:// or wss://' });
  }
  setZigbeeToken(userId, brokerUrl);
  return res.json({ ok: true });
});

app.delete('/api/v1/smart-home/zigbee/token', (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  deleteZigbeeToken(userId);
  return res.json({ ok: true });
});

// ── Sync (provider-aware) ──
app.post('/api/v1/smart-home/sync', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : 'yandex';
  try {
    const result = await syncSmartHomeDevices(userId, provider);
    return res.json(result);
  } catch (err: any) {
    if (err?.message === 'no_token') return res.status(400).json({ error: 'no_token' });
    if (err?.message === 'no_broker') return res.status(400).json({ error: 'no_broker' });
    return res.status(502).json({ error: 'sync_failed', detail: err?.message || String(err) });
  }
});

// ─── DevOps: Approve/reject pending command (from desktop via WS) ───────────

app.post('/api/v1/devops/approve', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const confirmationId = `${req.body?.confirmation_id || ''}`;
  const approved = req.body?.approved === true;
  const rejectionComment = req.body?.rejection_comment;
  const sudoPassword = typeof req.body?.sudo_password === 'string' ? req.body.sudo_password : undefined;
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : undefined;
  const saveSudoPassword = req.body?.save_sudo_password === true;

  if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });

  // Resolve pending confirmation
  const pending = getPendingConfirmation(confirmationId);
  if (!pending) return res.status(404).json({ error: 'not_found_or_expired' });
  if (pending.userId !== userId) return res.status(403).json({ error: 'forbidden' });

  if (!approved) {
    deletePendingConfirmation(confirmationId);
    pending.reject(buildRejectedByUserError(rejectionComment));
    return res.json({ ok: true, status: 'rejected' });
  }

  const pendingServer = getServerById(userId, pending.serverId);
  const needsSudoPassword = pending.needsSudoPassword === true || (pendingServer?.username !== 'root' && /\bsudo\b/.test(pending.command));

  // If command needs sudo but no sudo password provided — reject
  if (needsSudoPassword && !serverHasSudoPassword(userId, pending.serverId) && !sudoPassword) {
    return res.status(400).json({ error: 'sudo_password_required' });
  }
  if (pending.needsNewPassword === true && !newPassword) {
    return res.status(400).json({ error: 'new_password_required' });
  }
  // Save sudo password to server settings if requested
  if (saveSudoPassword && sudoPassword) {
    updateServer(userId, pending.serverId, { sudoPassword });
  }

  // Execute the approved command
  try {
    deletePendingConfirmation(confirmationId);
    const execOptions = (sudoPassword || newPassword) ? { sudoPasswordOverride: sudoPassword, newPasswordOverride: newPassword } : undefined;
    const result = pending.execute
      ? await pending.execute(execOptions)
      : await execSshCommand(userId, pending.serverId, pending.command, execOptions);
    pending.resolve(result);
    return res.json({ ok: true, status: 'executed', result });
  } catch (err: any) {
    pending.reject(err);
    return res.status(500).json({ error: 'ssh_exec_failed', details: err?.message });
  }
});

// ─── Email Send: Approve/reject pending email ──────────────────────────────

app.post('/api/v1/email/approve', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const confirmationId = `${req.body?.confirmation_id || ''}`;
  const approved = req.body?.approved === true;
  const rejectionComment = req.body?.rejection_comment;

  if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const pending = getPendingEmailConfirmation(confirmationId);
  if (!pending) return res.status(404).json({ error: 'not_found_or_expired' });
  if (pending.userId !== userId) return res.status(403).json({ error: 'forbidden' });

  if (!approved) {
    deletePendingEmailConfirmation(confirmationId);
    pending.reject(buildRejectedByUserError(rejectionComment));
    return res.json({ ok: true, status: 'rejected' });
  }

  // Send the approved email
  try {
    deletePendingEmailConfirmation(confirmationId);
    const result = await runEmailSend(userId, pending.to, pending.subject, pending.body, pending.provider, pending.mailAccountId);
    pending.resolve(result);
    return res.json({ ok: true, status: 'sent', result });
  } catch (err: any) {
    pending.reject(err);
    return res.status(500).json({ error: 'email_send_failed', details: err?.message });
  }
});

// ─── PC Commands: Settings ─────────────────────────────────────────────────

app.get('/api/v1/pc-commands/settings', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const settings = getPcCommandsSettings(userId);
  return res.json(settings);
});

app.put('/api/v1/pc-commands/settings', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const updates: { fs_scan_enabled?: boolean; auto_approve_all?: boolean; file_read_enabled?: boolean } = {};
  if (typeof req.body?.fs_scan_enabled === 'boolean') updates.fs_scan_enabled = req.body.fs_scan_enabled;
  if (typeof req.body?.auto_approve_all === 'boolean') updates.auto_approve_all = req.body.auto_approve_all;
  if (typeof req.body?.file_read_enabled === 'boolean') updates.file_read_enabled = req.body.file_read_enabled;
  updatePcCommandsSettings(userId, updates);
  return res.json({ ok: true });
});

// ─── PC Commands: Policies ─────────────────────────────────────────────────

app.get('/api/v1/pc-commands/policies', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const policies = listPcCommandPolicies(userId);
  return res.json({ policies });
});

app.post('/api/v1/pc-commands/policies', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const pattern = `${req.body?.pattern || ''}`;
  const result = createPcCommandPolicy(userId, pattern);
  if (!result.ok) return res.status(400).json({ error: (result as { ok: false; error: string }).error });
  return res.status(201).json({ id: result.id });
});

app.delete('/api/v1/pc-commands/policies/:id', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const policyId = Number(req.params.id);
  if (!policyId) return res.status(400).json({ error: 'id_required' });
  const deleted = deletePcCommandPolicy(userId, policyId);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
});

// ─── PC Commands: Approve/reject pending command ───────────────────────────

app.post('/api/v1/pc-commands/approve', async (req: AuthedRequest, res: any) => {
  const userId = accountIdFromRequest(req);
  const confirmationId = `${req.body?.confirmation_id || ''}`;
  const approved = req.body?.approved === true;
  const rejectionComment = req.body?.rejection_comment;

  console.log('[pc_command] approve request', { userId, confirmationId, approved });

  if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });

  const pending = getPendingPcConfirmation(confirmationId);
  if (!pending) {
    console.warn('[pc_command] approve missing pending confirmation', { userId, confirmationId, approved });
    return res.status(404).json({ error: 'not_found_or_expired' });
  }
  if (pending.userId !== userId) {
    console.warn('[pc_command] approve forbidden', { userId, pendingUserId: pending.userId, confirmationId });
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!approved) {
    deletePendingPcConfirmation(confirmationId);
    console.log('[pc_command] rejected by user', { userId, confirmationId });
    pending.reject(buildRejectedByUserError(rejectionComment));
    return res.json({ ok: true, status: 'rejected' });
  }

  // Execute the approved command on user's PC via WS IPC
  try {
    deletePendingPcConfirmation(confirmationId);
    const { sendIpcToDesktop } = await import('./ws-clients.js');
    console.log('[pc_action] approved, executing via desktop ipc', {
      userId,
      confirmationId,
      kind: pending.kind,
      label: pending.label.slice(0, 500),
    });
    const ipcTimeout = pending.payload.ipcType === 'execute_commands' ? 150000 : 60000;
    const result = await sendIpcToDesktop(userId, pending.payload.ipcType, pending.payload.ipcPayload, ipcTimeout);
    console.log('[pc_action] desktop ipc completed', {
      userId,
      confirmationId,
      resultPreview: typeof result === 'string' ? result.slice(0, 500) : undefined,
    });
    pending.resolve(result);
    return res.json({ ok: true, status: 'executed', result });
  } catch (err: any) {
    console.error('[pc_action] desktop ipc failed', {
      userId,
      confirmationId,
      error: err?.message || String(err),
    });
    pending.reject(err);
    return res.status(500).json({ error: 'pc_exec_failed', details: err?.message });
  }
});

// ── Internal: PC Command approve/reject (for TG bot) ──────────────────────

app.post('/internal/pc-commands/approve', internalAuth, async (req, res) => {
    const confirmationId = `${req.body?.confirmation_id || ''}`;
    const approved = req.body?.approved === true;
    const allowWorkspaceSession = req.body?.allow_workspace_session === true;
    const userId = resolveInternalAccountId(req.body?.user_id);
    const rejectionComment = req.body?.rejection_comment;

    if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const pending = getPendingPcConfirmation(confirmationId);
  if (!pending) {
    return res.status(404).json({ error: 'not_found_or_expired' });
  }
  if (pending.userId !== userId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!approved) {
    deletePendingPcConfirmation(confirmationId);
    pending.reject(buildRejectedByUserError(rejectionComment));
    return res.json({ ok: true, status: 'rejected' });
  }

  if (allowWorkspaceSession && (
    pending.kind !== 'file_action'
    || !['write_file', 'edit_file_lines'].includes(pending.payload.ipcType)
  )) {
    return res.status(400).json({ error: 'workspace_session_not_available_for_action' });
  }

  try {
    deletePendingPcConfirmation(confirmationId);
    const { sendIpcToDesktop } = await import('./ws-clients.js');
    let workspace: unknown;
    if (allowWorkspaceSession) {
      try {
        const filePath = 'file_path' in pending.payload.ipcPayload
          ? pending.payload.ipcPayload.file_path
          : '';
        workspace = await sendIpcToDesktop(
          pending.userId,
          'grant_session_write_workspace',
          { file_path: filePath },
          15000,
        );
      } catch (error: any) {
        workspace = { granted: false, reason: error?.message || 'workspace_grant_failed' };
      }
    }
    const ipcTimeout = pending.payload.ipcType === 'execute_commands' ? 150000 : 60000;
    const result = await sendIpcToDesktop(pending.userId, pending.payload.ipcType, pending.payload.ipcPayload, ipcTimeout);
    pending.resolve(result);
    return res.json({ ok: true, status: 'executed', result, workspace });
  } catch (err: any) {
    pending.reject(err);
    return res.status(500).json({ error: 'pc_exec_failed', details: err?.message });
  }
});

// ── Internal: PC Command auto-approve policy create (for TG bot) ───────────

app.post('/internal/pc-commands/policies', internalAuth, async (req, res) => {
  const userId = resolveInternalAccountId(req.body?.user_id);
  const pattern = `${req.body?.pattern || ''}`;

  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });
  if (!pattern.trim()) return res.status(400).json({ error: 'pattern_required' });

  const result = createPcCommandPolicy(userId, pattern);
  if (!result.ok) return res.status(400).json({ error: (result as { ok: false; error: string }).error });
  return res.json({ ok: true, id: result.id });
});

// ── Internal: Visual Click approve/reject (for TG bot) ──────────────────────

app.post('/internal/visual-click/approve', internalAuth, async (req, res) => {
  const confirmationId = `${req.body?.confirmation_id || ''}`;
  const approved = req.body?.approved === true;
  const userId = resolveInternalAccountId(req.body?.user_id);

  if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const pending = getPendingVisualClick(confirmationId);
  if (!pending) {
    return res.status(404).json({ error: 'not_found_or_expired' });
  }
  if (pending.userId !== userId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!approved) {
    deletePendingVisualClick(confirmationId);
    pending.reject(new Error('rejected_by_user'));
    return res.json({ ok: true, status: 'rejected' });
  }

  try {
    deletePendingVisualClick(confirmationId);
    const { sendIpcToDesktop } = await import('./ws-clients.js');
    const result = await sendIpcToDesktop(
      pending.userId,
      'visual_click',
      { display_id: pending.display_id, x: pending.x, y: pending.y, button: pending.button },
      15000
    );
    pending.resolve(result);
    return res.json({ ok: true, status: 'executed', result });
  } catch (err: any) {
    pending.reject(err);
    return res.status(500).json({ error: 'visual_click_failed', details: err?.message });
  }
});

// ── Internal: LITE AI review (for TG bot safety check) ─────────────────────

app.post('/internal/ai/lite', internalAuth, async (req, res) => {
  const text = `${req.body?.text || ''}`;
  const promptType = `${req.body?.prompt_type || ''}`;
  const command = `${req.body?.command || ''}`;

  // Review SSH command: build prompt on the backend (single source of truth)
  if (promptType === 'review_ssh' && command.trim()) {
    const userId = resolveInternalAccountId(req.body?.user_id);
    const user = Number.isFinite(userId) && userId > 0 ? getUserById(userId) : undefined;
    const systemPrompt = translateForLanguage(user?.language, 'confirmations.reviewSshSystem');
    const userPrompt = translateForLanguage(user?.language, 'confirmations.reviewSshPrompt', { command: command.trim(), language: normalizeSupportedLanguage(user?.language) || 'English' });
    try {
      const reply = await callLiteAi(systemPrompt, userPrompt);
      return res.json({ reply_text: reply });
    } catch (err: any) {
      return res.status(500).json({ error: 'lite_ai_failed', details: err?.message });
    }
  }

  if (!text.trim()) return res.status(400).json({ error: 'empty_text' });

  try {
    const reply = await callLiteAi('Ты — эксперт по безопасности. Ответь кратко.', text);
    return res.json({ reply_text: reply });
  } catch (err: any) {
    return res.status(500).json({ error: 'lite_ai_failed', details: err?.message });
  }
});

// ── Internal: DevOps approve/reject (for TG bot) ──────────────────────────

app.post('/internal/devops/approve', internalAuth, async (req, res) => {
  const confirmationId = `${req.body?.confirmation_id || ''}`;
  const approved = req.body?.approved === true;
  const userId = resolveInternalAccountId(req.body?.user_id);
  const sudoPassword = typeof req.body?.sudo_password === 'string' ? req.body.sudo_password : undefined;
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : undefined;
  const rejectionComment = req.body?.rejection_comment;

  if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const pending = getPendingConfirmation(confirmationId);
  if (!pending) return res.status(404).json({ error: 'not_found_or_expired' });
  if (pending.userId !== userId) return res.status(403).json({ error: 'forbidden' });

  if (!approved) {
    deletePendingConfirmation(confirmationId);
    pending.reject(buildRejectedByUserError(rejectionComment));
    return res.json({ ok: true, status: 'rejected' });
  }

  const pendingServer = getServerById(pending.userId, pending.serverId);
  const needsSudoPassword = pending.needsSudoPassword === true || (pendingServer?.username !== 'root' && /\bsudo\b/.test(pending.command));

  if (needsSudoPassword && !serverHasSudoPassword(pending.userId, pending.serverId) && !sudoPassword) {
    return res.status(400).json({ error: 'sudo_password_required' });
  }
  if (pending.needsNewPassword === true && !newPassword) {
    return res.status(400).json({ error: 'new_password_required' });
  }

  try {
    deletePendingConfirmation(confirmationId);
    const execOptions = (sudoPassword || newPassword) ? { sudoPasswordOverride: sudoPassword, newPasswordOverride: newPassword } : undefined;
    const result = pending.execute
      ? await pending.execute(execOptions)
      : await execSshCommand(pending.userId, pending.serverId, pending.command, execOptions);
    pending.resolve(result);
    return res.json({ ok: true, status: 'executed', result });
  } catch (err: any) {
    pending.reject(err);
    return res.status(500).json({ error: 'ssh_exec_failed', details: err?.message });
  }
});

// ── Internal: Email Send confirmation (for TG bot) ─────────────────────────

app.post('/internal/email/approve', internalAuth, async (req, res) => {
  const confirmationId = `${req.body?.confirmation_id || ''}`;
  const approved = req.body?.approved === true;
  const userId = resolveInternalAccountId(req.body?.user_id);
  const rejectionComment = req.body?.rejection_comment;

  if (!confirmationId) return res.status(400).json({ error: 'confirmation_id_required' });
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'bad_user_id' });

  const pending = getPendingEmailConfirmation(confirmationId);
  if (!pending) return res.status(404).json({ error: 'not_found_or_expired' });
  if (pending.userId !== userId) return res.status(403).json({ error: 'forbidden' });

  if (!approved) {
    deletePendingEmailConfirmation(confirmationId);
    pending.reject(buildRejectedByUserError(rejectionComment));
    return res.json({ ok: true, status: 'rejected' });
  }

  try {
    deletePendingEmailConfirmation(confirmationId);
    const result = await runEmailSend(pending.userId, pending.to, pending.subject, pending.body, pending.provider, pending.mailAccountId);
    pending.resolve(result);
    return res.json({ ok: true, status: 'sent', result });
  } catch (err: any) {
    pending.reject(err);
    return res.status(500).json({ error: 'email_send_failed', details: err?.message });
  }
});

// ── Internal: DevOps SSH auto-approve policy (for TG bot) ──────────────────

app.post('/internal/devops/servers/:id/policies', internalAuth, async (req, res) => {
  const serverId = Number(req.params.id);
  const userId = resolveInternalAccountId(req.body?.user_id);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'invalid_id' });
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'user_id_required' });

  const pattern = `${req.body?.pattern || ''}`;
  const autoApprove = req.body?.auto_approve === true;

  const result = createPolicy(userId, serverId, pattern, autoApprove);
  if (!result.ok) {
    const code = (result as { ok: false; error: string }).error;
    if (code === 'not_found') return res.status(404).json({ error: code });
    return res.status(400).json({ error: code });
  }
  return res.status(201).json({ id: result.id });
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('API error:', formatSafeError(err));
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, () => {
  console.log(`[backend-api] started on :${PORT}`);
  // Seed plan_limits_config with defaults if empty (first run only).
  try {
    seedPlanLimitsIfEmpty();
  } catch (err) {
    console.warn('[plan-limits] seed failed:', formatSafeError(err));
  }
  if (BACKEND_VOICE_API_ENABLED) {
    console.log('[backend-voice] enabled (BACKEND_VOICE_API_ENABLED=1), endpoint: POST /internal/voice/turn');
  } else {
    console.log('[backend-voice] disabled (BACKEND_VOICE_API_ENABLED != 1)');
  }
  console.log('[backend-photo] endpoint enabled: POST /internal/photo/analyze');
  if (BACKEND_VECTOR_MEMORY_API_ENABLED) {
    console.log('[backend-vector-memory] enabled (BACKEND_VECTOR_MEMORY_API_ENABLED=1), endpoints: POST /api/v1/vector-memory/chunks, POST /api/v1/vector-memory/search');
  } else {
    console.log('[backend-vector-memory] disabled (BACKEND_VECTOR_MEMORY_API_ENABLED != 1)');
  }
  startTaskScheduler();
  initSubagentRunner({ runCompletion, runTool, throwIfAborted, withAbort, toolDefinitions, normalizeTokenUsage });

  setImmediate(async () => {
    try {
      const result = await migratePendingAccountNamespaces();
      if (result.migrated > 0 || result.failed > 0) {
        console.log('[vector-memory] namespace migration pass finished', result);
      }
    } catch (err) {
      console.error('[vector-memory] namespace migration startup error:', formatSafeError(err));
    }
  });

});

// Increase timeout for long-running AI requests (tool loops, streaming)
server.timeout = 5 * 60 * 1000;       // 5 minutes
server.keepAliveTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000 + 1000;

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log(`[WS] New connection, host: ${req.headers.host || 'unknown'}`);

  // 1. Authenticate via query param
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  if (!token) { console.log('[WS] REJECTED: no token'); ws.close(4001, 'no_token'); return; }

  const payload = verifyToken(token, 'access');
  if (!payload) { console.log('[WS] REJECTED: invalid token'); ws.close(4001, 'invalid_token'); return; }

  const accountId = payload.sub;
  console.log(`[WS] Token valid, accountId=${accountId}`);

  // 2. Kick existing connection for this user
  const existing = wsClients.get(accountId);
  if (existing) {
    unregisterWsClient(existing);
    for (const [, pending] of existing.pendingIpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ws_replaced'));
    }
    existing.pendingIpc.clear();
    existing.ws.removeAllListeners();
    existing.ws.close(4002, 'replaced');
  }

  // 3. Register client under the canonical account ID
  const now = Date.now();
  const client: WsClient = {
    ws,
    accessToken: token,
    accountId,
    pendingIpc: new Map(),
    connectionId: `${accountId}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    connectedAt: now,
    lastMessageAt: now,
    lastPingAt: 0,
    lastPongAt: now,
    missedPongs: 0,
    authRefreshInFlight: false,
  };
  registerWsClient(client);
  console.log('[ws] account connected', {
    accountId,
    connectionId: client.connectionId,
    replacedExisting: !!existing,
    total: wsClients.size,
  });

  // 4. Handle incoming messages
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      client.lastMessageAt = Date.now();

      // Allow an authenticated desktop to rotate the access token without
      // dropping an in-progress stream. The new token MUST be fully valid
      // (signature, exp, principal, version, sak) — strict verifyToken.
      // A revoked/banned user must NOT be able to push a fresh token here.
      if (msg.type === 'auth_refresh') {
        const nextToken = typeof msg.token === 'string' ? msg.token.trim() : '';
        if (!nextToken) {
          ws.close(4001, 'invalid_refresh_token');
          return;
        }
        const nextPayload = verifyToken(nextToken, 'access');
        if (!nextPayload || nextPayload.sub !== client.accountId) {
          ws.close(4001, 'invalid_refresh_token');
          return;
        }
        client.accessToken = nextToken;
        client.lastPongAt = Date.now();
        client.missedPongs = 0;
        client.authRefreshInFlight = false;
        ws.send(JSON.stringify({ type: 'auth_refreshed' }));
        return;
      }

      // For any other message: if the access token is invalid (signature,
      // version, user status, sak) → drop. If only `exp` is gone → ask for
      // refresh. verifyTokenIgnoreExpiry enforces all principal-level checks.
      const currentPayload = verifyTokenIgnoreExpiry(client.accessToken, 'access');
      if (!currentPayload) {
        ws.close(4001, 'token_revoked');
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (currentPayload.exp <= nowSec) {
        // Token expired — request a refresh instead of dropping the socket.
        // Allow `ping`/`pong` through so heartbeat doesn't break during the
        // refresh round-trip.
        if (msg.type === 'ping' || msg.type === 'pong') {
          client.lastPongAt = Date.now();
          client.missedPongs = 0;
          if (msg.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
          }
          return;
        }
        // Debounce: don't spam auth_refresh_required on every incoming message.
        if (!client.authRefreshInFlight) {
          client.authRefreshInFlight = true;
          try { ws.send(JSON.stringify({ type: 'auth_refresh_required' })); } catch { /* ignore */ }
        }
        return;
      }

      if (msg.type === 'chat_send') {
        await handleWsChatSend(client, msg);
      } else if (msg.type === 'chat_stop') {
        const userId = client.accountId;
        const controller = activeGenerations.get(userId);
        if (controller) {
          controller.abort();
        }
        // Ответ не нужен — клиент получит done с aborted: true
      } else if (msg.type === 'ipc_result') {
        handleIpcResult(client, msg);
      } else if (msg.type === 'ping') {
        client.lastPongAt = Date.now();
        client.missedPongs = 0;
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'pong') {
        client.lastPongAt = Date.now();
        client.missedPongs = 0;
      }
    } catch (err) {
      console.error('[ws] message error:', formatSafeError(err));
      const currentClient = wsClients.get(accountId);
      if (currentClient?.ws.readyState === WebSocket.OPEN) {
        currentClient.ws.send(JSON.stringify({ type: 'error', error: 'request_processing_failed' }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    // Check if this socket was already superseded by a newer connection.
    const wasAlreadyReplaced = wsClients.get(accountId) !== client;
    unregisterWsClient(client);
    // Reject all pending IPC requests
    for (const [, pending] of client.pendingIpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ws_disconnected'));
    }
    const reasonStr = reason?.toString() || '';
    const replacement = wsClients.get(accountId);
    console.log('[ws] account disconnected', {
      accountId,
      connectionId: client.connectionId,
      code,
      reason: reasonStr,
      replacedByNew: !!replacement,
      replacementConnectionId: replacement?.connectionId ?? null,
      total: wsClients.size,
    });
    if (wasAlreadyReplaced) {
      console.log('[ws-transport] closed socket was already replaced — active generation continues unaffected', {
        accountId,
        oldConnectionId: client.connectionId,
      });
    }
  });
});

setInterval(() => {
  const uniqueClients = new Set<WsClient>(wsClients.values());
  const now = Date.now();
  for (const client of uniqueClients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // If signature/version is invalid → revoke. If only expired → nudge refresh.
    const payload = verifyTokenIgnoreExpiry(client.accessToken, 'access');
    if (!payload) {
      client.ws.close(4001, 'token_revoked');
      continue;
    }
    if (payload.exp <= Math.floor(now / 1000)) {
      // Ask the client to refresh instead of dropping the connection.
      // Debounce: one nudge per refresh round-trip.
      if (!client.authRefreshInFlight) {
        client.authRefreshInFlight = true;
        try { client.ws.send(JSON.stringify({ type: 'auth_refresh_required' })); } catch { /* ignore */ }
      }
    }

    const lastPongAgeMs = now - client.lastPongAt;
    if (lastPongAgeMs > WS_HEARTBEAT_GRACE_MS) {
      console.warn('[ws] heartbeat stale, terminating connection', {
        accountId: client.accountId,
        connectionId: client.connectionId,
        lastPongAgeMs,
        pendingIpcCount: client.pendingIpc.size,
      });
      client.ws.terminate();
      continue;
    }

    client.lastPingAt = now;
    client.missedPongs += 1;
    client.ws.send(JSON.stringify({ type: 'ping', t: now }), (err) => {
      if (err) {
        console.warn('[ws] heartbeat ping failed', {
          accountId: client.accountId,
          connectionId: client.connectionId,
          error: err.message,
        });
      }
    });
  }
}, WS_HEARTBEAT_INTERVAL_MS);

// ── WS chat_send handler ────────────────────────────────────────────────────

async function handleWsChatSend(client: WsClient, msg: any) {
  const { text, chat_id, images, documents, display_manifest, is_voice, preferred_model, regenerate_hint, regenerate_from_history } = msg;
  if (!text?.trim()) {
    client.ws.send(JSON.stringify({ type: 'error', error: 'empty_text' }));
    return;
  }

  const userId = client.accountId;

  // Parse & validate images
  const MAX_IMAGE_BYTES_API = 20 * 1024 * 1024;
  const imagesRaw: Array<any> = Array.isArray(images) ? images : [];
  const imageUser = getUserById(userId);
  if (imagesRaw.length > 0 && imageUser && !areImageAttachmentsAllowedForPlan(imageUser.plan, imageUser.is_admin === 1)) {
    client.ws.send(JSON.stringify({ type: 'error', error: 'images_not_allowed_for_plan' }));
    return;
  }
  const parsedImages = imagesRaw
    .map((img: any) => ({
      base64: `${img?.base64 || ''}`.trim(),
      mimeType: `${img?.mime_type || 'image/jpeg'}`.trim() || 'image/jpeg',
    }))
    .filter(img => img.base64.length > 0);

  if (parsedImages.length > MAX_IMAGE_ATTACHMENTS_PER_REQUEST) {
    client.ws.send(JSON.stringify({ type: 'error', error: `too_many_images_max_${MAX_IMAGE_ATTACHMENTS_PER_REQUEST}` }));
    return;
  }

  let totalImageBytes = 0;
  for (const img of parsedImages) {
    const buf = Buffer.from(img.base64, 'base64');
    if (!buf.length) continue;
    if (buf.length > MAX_IMAGE_BYTES_API) {
      client.ws.send(JSON.stringify({ type: 'error', error: 'image_too_large' }));
      return;
    }
    totalImageBytes += buf.length;
    if (totalImageBytes > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES) {
      client.ws.send(JSON.stringify({ type: 'error', error: 'image_payload_too_large' }));
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
      console.error('[ws] failed to save image thumbnails:', formatSafeError(err));
    }
  }

  // Parse, validate & save documents (attachments)
  let savedUserAttachments: any[] | null = null;
  const documentsRaw: Array<any> = Array.isArray(documents) ? documents : [];
  if (documentsRaw.length > 0) {
    try {
      const { saveUserDocument } = await import('./services/attachment-storage.js');
      const saved: any[] = [];
      for (const doc of documentsRaw) {
        const base64 = `${doc?.base64 || ''}`.trim();
        const filename = `${doc?.filename || 'document'}`.trim();
        if (!base64) continue;
        const buf = Buffer.from(base64, 'base64');
        if (!buf.length) continue;
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          client.ws.send(JSON.stringify({ type: 'error', error: 'document_too_large', filename }));
          return;
        }
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          client.ws.send(JSON.stringify({ type: 'error', error: 'unsupported_document_format', filename, ext }));
          return;
        }
        const extractedText = await parseDocument(buf, filename);
        const stored = await saveUserDocument(buf, filename);
        saved.push({
          name: filename,
          size_bytes: buf.length,
          mime_type: guessMimeType(filename),
          extracted_text: extractedText,
          url: stored.url,
          filename: stored.filename,
        });
      }
      savedUserAttachments = saved.length > 0 ? saved : null;
    } catch (err: any) {
      console.error('[ws] failed to save documents:', formatSafeError(err));
      client.ws.send(JSON.stringify({ type: 'error', error: 'document_parse_failed', detail: err?.message || String(err) }));
      return;
    }
  }

  const currentClient = wsClients.get(userId);
  if (currentClient?.ws.readyState === WebSocket.OPEN) {
    currentClient.ws.send(JSON.stringify({ type: 'chat_accepted' }));
  }

  const enabledMacros = getEnabledMacros(userId);
  // Transport-safe WS sender: looks up the CURRENT client on every call so
  // reconnections are transparent. Never rejects — ephemeral UI events must
  // not break AI generation. Returns false if delivery was not possible.
  let wsTransportLostLogged = false;
  const sendWsJson = (payload: Record<string, unknown>): Promise<boolean> => {
    const currentClient = wsClients.get(userId);
    if (!currentClient || currentClient.ws.readyState !== WebSocket.OPEN) {
      if (!wsTransportLostLogged) {
        wsTransportLostLogged = true;
        console.warn('[ws-transport] client disconnected mid-stream, UI events will be skipped until reconnect', {
          userId,
          accountId: client.accountId,
          connectionId: client.connectionId,
        });
      }
      return Promise.resolve(false);
    }
    try {
      currentClient.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          console.warn('[ws-transport] send failed (non-fatal)', {
            userId,
            payloadType: payload.type,
            error: err.message,
          });
        }
      });
    } catch (err: any) {
      console.warn('[ws-transport] send threw (non-fatal)', {
        userId,
        payloadType: payload.type,
        error: err?.message || String(err),
      });
    }
    return Promise.resolve(true);
  };

  try {
    const rawUserRecord = getUserById(userId);
    const result = await sendMessageThroughAi(userId, text, chat_id, {
      ...(parsedImages.length > 0 ? { images: parsedImages } : {}),
      userImages: savedUserImages,
      ...(savedUserAttachments ? { userAttachments: savedUserAttachments } : {}),
      displayManifest: display_manifest,
      currentDisplayState: msg.current_display_state ?? null,
      isDesktop: true,
      isVoice: Boolean(is_voice),
      activeMacros: enabledMacros,
      preferredModel: preferred_model || undefined,
      regenerateHint: regenerate_hint || undefined,
      regenerateFromHistory: Boolean(regenerate_from_history),
      skipUserHistory: Boolean(msg.skip_user_history),
      featureFlags: rawUserRecord ? parseFeatureFlags(rawUserRecord) : undefined,
      diceRollMode: Boolean(parseUiSettings(rawUserRecord ?? getUserById(userId)).dice_roll_enabled),
      ...(() => { const fv = resolveDiceForceValue(msg.dice_mode); return fv !== undefined ? { diceRollForceValue: fv } : {}; })(),
      onIntermediateMessage: async (stepText) => {
        await sendWsJson({ type: 'intermediate', text: stepText });
      },
      onStateChange: async (state) => {
        await sendWsJson({ type: 'display_state', ...state });
      },
      onDesktopAction: async (action) => {
        await sendWsJson({ type: 'desktop_action', ...action });
      },
      onToolStatus: async (statusText) => {
        await sendWsJson({ type: 'tool_status', text: statusText });
      },
      onMapUpdate: async (data) => {
        await sendWsJson({ type: 'map_update', ...data });
      },
      onDiceRoll: async (roll) => {
        await sendWsJson({ type: 'dice_roll', roll });
      },
      onStreamToken: async (text) => {
        await sendWsJson({ type: 'stream_token', text });
      },
      onReasoningStream: async (text) => {
        await sendWsJson({ type: 'reasoning_token', text });
      },
    });

    // Send 'done' through the current connection (may have reconnected since).
    sendWsJson({ type: 'done', ...result });
  } catch (err: any) {
    const payload = buildLocalizedAiError(err, userId);
    // Send 'error' through the current connection (may have reconnected since).
    // If desktop is offline, the user will see the result/error on next chat refresh.
    sendWsJson({ type: 'error', ...payload });
  }
}
// ── WS ipc_result handler ────────────────────────────────────────────────────

function handleIpcResult(client: WsClient, msg: any) {
  const { request_id, data, error } = msg;
  const pending = client.pendingIpc.get(request_id);
  console.log('[ipc] ipc_result received', {
    accountId: client.accountId,
    requestId: request_id,
    hasPending: Boolean(pending),
    hasError: Boolean(error),
    dataType: typeof data,
    dataPreview: typeof data === 'string' ? data.slice(0, 300) : undefined,
  });
  if (!pending) return;

  clearTimeout(pending.timer);
  client.pendingIpc.delete(request_id);

  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(data);
  }
}
