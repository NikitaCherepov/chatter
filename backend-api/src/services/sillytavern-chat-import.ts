import { createHash } from 'node:crypto';
import { db, getNowUnix } from '../db.js';
import { resolveAccountId } from './accounts.js';
import { createUserChat } from './chats.js';
import { getChatMemorySettings, updateChatMemorySettings } from './memory-foundation.js';
import { toUserPromptSelectedId } from './prompts.js';
import { countTokens } from './tokenizer.js';
import { attachmentReferences } from './sillytavern-chat-media.js';

export const MAX_SILLYTAVERN_CHAT_BYTES = 16 * 1024 * 1024;
export const MAX_SILLYTAVERN_CHAT_FILES = 20;
export const MAX_SILLYTAVERN_CHAT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES = 100_000;

type JsonObject = Record<string, unknown>;
type ParsedMessage = {
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  createdAt: string;
  name: string;
  variants: string[];
  activeVariantIndex: number;
};

type ParsedChat = {
  fileName: string;
  raw: string;
  hash: string;
  header: JsonObject;
  characterName: string;
  userName: string;
  title: string;
  messages: ParsedMessage[];
  warnings: string[];
};

export type SillyTavernChatPreview = {
  file_name: string;
  title: string;
  character_name: string;
  user_name: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  matched_prompt_id: number | null;
  matched_prompt_name: string | null;
  matched_persona_id: number | null;
  matched_persona_name: string | null;
  already_imported_chat_id: number | null;
  warnings: string[];
};

export type SillyTavernChatFile = { file_name: string; base64: string };

const asObject = (value: unknown): JsonObject | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const asString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const decodeFile = (file: SillyTavernChatFile): Buffer => {
  const data = Buffer.from(`${file.base64 || ''}`.trim(), 'base64');
  if (!data.length) throw new Error('sillytavern_chat_file_required');
  if (data.length > MAX_SILLYTAVERN_CHAT_BYTES) throw new Error('sillytavern_chat_file_too_large');
  return data;
};

const parseDate = (value: unknown, fallbackMs: number): string => {
  let ms = Number.NaN;
  if (typeof value === 'number' && Number.isFinite(value)) ms = value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (/^\d{10,13}$/.test(text)) {
      const numeric = Number(text);
      ms = text.length > 10 ? numeric : numeric * 1000;
    } else {
      const custom = /^(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s$/i.exec(text);
      ms = custom
        ? Date.UTC(Number(custom[1]), Number(custom[2]) - 1, Number(custom[3]), Number(custom[4]), Number(custom[5]), Number(custom[6]))
        : Date.parse(text);
    }
  }
  const safeMs = Number.isFinite(ms) ? ms : fallbackMs;
  return new Date(safeMs).toISOString().slice(0, 19).replace('T', ' ');
};

const safeTitle = (fileName: string, characterName: string): string => {
  const fromFile = fileName.replace(/\.jsonl$/i, '').trim();
  return (fromFile || characterName || fileName).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
};

const parseChat = (file: SillyTavernChatFile): ParsedChat => {
  const data = decodeFile(file);
  const raw = data.toString('utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('sillytavern_chat_empty');
  if (lines.length > MAX_MESSAGES + 1) throw new Error('sillytavern_chat_too_many_messages');
  const parsedLines = lines.map((line, index) => {
    try {
      const object = asObject(JSON.parse(line) as unknown);
      if (!object) throw new Error();
      return object;
    } catch {
      throw new Error(`sillytavern_chat_invalid_line:${index + 1}`);
    }
  });
  const first = parsedLines[0];
  const hasHeader = !('mes' in first) && ('chat_metadata' in first || 'character_name' in first || 'user_name' in first);
  const header = hasHeader ? first : {};
  const rows = hasHeader ? parsedLines.slice(1) : parsedLines;
  const characterName = asString(header.character_name);
  const userName = asString(header.user_name);
  const baseDate = parseDate(header.create_date, Date.now());
  const baseMs = Date.parse(`${baseDate.replace(' ', 'T')}Z`);
  const warnings: string[] = [];
  if (!hasHeader) warnings.push('missing_metadata');
  let systemMessages = 0;
  let skippedEmpty = 0;
  const messages = rows.flatMap((row, index): ParsedMessage[] => {
    const mes = typeof row.mes === 'string' ? row.mes : '';
    if (!mes.trim() && !attachmentReferences(row.extra).length) {
      skippedEmpty += 1;
      return [];
    }
    if (row.is_system === true) systemMessages += 1;
    const extra = asObject(row.extra);
    const reasoning = typeof extra?.reasoning === 'string' && extra.reasoning.trim() ? extra.reasoning : null;
    const swipeValues = row.is_user === true || !Array.isArray(row.swipes)
      ? []
      : row.swipes.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    const variants = swipeValues.length > 0 ? [...swipeValues] : [mes];
    let activeVariantIndex = variants.findIndex(value => value === mes);
    const requestedSwipeIndex = Number(row.swipe_id);
    if (
      Number.isSafeInteger(requestedSwipeIndex)
      && requestedSwipeIndex >= 0
      && requestedSwipeIndex < variants.length
      && variants[requestedSwipeIndex] === mes
    ) {
      activeVariantIndex = requestedSwipeIndex;
    }
    if (activeVariantIndex < 0) {
      variants.push(mes);
      activeVariantIndex = variants.length - 1;
    }
    return [{
      role: row.is_user === true ? 'user' : 'assistant',
      content: mes,
      reasoning,
      createdAt: parseDate(row.send_date, baseMs + index * 1000),
      name: asString(row.name),
      variants,
      activeVariantIndex,
    }];
  });
  if (!messages.length) throw new Error('sillytavern_chat_no_messages');
  if (systemMessages) warnings.push('system_messages_as_assistant');
  if (skippedEmpty) warnings.push('empty_messages_skipped');
  if (rows.some(row => attachmentReferences(row.extra).length || (Array.isArray(row.swipe_info) && row.swipe_info.some((swipe: any) => attachmentReferences(swipe?.extra).length)))) warnings.push('attachments_not_imported');
  return {
    fileName: file.file_name,
    raw,
    hash: createHash('sha256').update(data).digest('hex'),
    header,
    characterName,
    userName,
    title: safeTitle(file.file_name, characterName),
    messages,
    warnings,
  };
};

const findPrompt = (userId: number, characterName: string) => {
  if (!characterName) return null;
  const row = db.prepare(`
    SELECT prompt.id, prompt.name
    FROM user_prompts prompt
    LEFT JOIN user_prompt_character_cards card ON card.prompt_id = prompt.id
    WHERE prompt.user_id = ? AND prompt.name = ? COLLATE NOCASE
    ORDER BY (card.prompt_id IS NOT NULL) DESC, prompt.id DESC
    LIMIT 1
  `).get(userId, characterName) as { id: number; name: string } | undefined;
  return row ? { id: toUserPromptSelectedId(row.id), name: row.name } : null;
};

const findPersona = (userId: number, parsed: ParsedChat) => {
  const metadata = asObject(parsed.header.chat_metadata);
  const personaKey = asString(metadata?.persona);
  if (personaKey) {
    const byKey = db.prepare('SELECT id, name FROM personas WHERE user_id = ? AND import_key = ? LIMIT 1')
      .get(userId, personaKey) as { id: number; name: string } | undefined;
    if (byKey) return byKey;
  }
  if (!parsed.userName) return null;
  return (db.prepare('SELECT id, name FROM personas WHERE user_id = ? AND name = ? COLLATE NOCASE ORDER BY is_primary DESC, id ASC LIMIT 1')
    .get(userId, parsed.userName) as { id: number; name: string } | undefined) || null;
};

const previewParsed = (userId: number, parsed: ParsedChat): SillyTavernChatPreview => {
  const prompt = findPrompt(userId, parsed.characterName);
  const persona = findPersona(userId, parsed);
  const existing = db.prepare('SELECT chat_id FROM sillytavern_chat_imports WHERE user_id = ? AND source_hash = ?')
    .get(userId, parsed.hash) as { chat_id: number } | undefined;
  const warnings = [...parsed.warnings];
  if (!prompt) warnings.push('character_not_matched');
  if (!persona && parsed.userName) warnings.push('persona_not_matched');
  if (existing) warnings.push('already_imported');
  return {
    file_name: parsed.fileName,
    title: parsed.title,
    character_name: parsed.characterName,
    user_name: parsed.userName,
    message_count: parsed.messages.length,
    user_message_count: parsed.messages.filter(message => message.role === 'user').length,
    assistant_message_count: parsed.messages.filter(message => message.role === 'assistant').length,
    matched_prompt_id: prompt?.id ?? null,
    matched_prompt_name: prompt?.name ?? null,
    matched_persona_id: persona?.id ?? null,
    matched_persona_name: persona?.name ?? null,
    already_imported_chat_id: existing?.chat_id ?? null,
    warnings,
  };
};

const validateBatch = (files: SillyTavernChatFile[]) => {
  if (!Array.isArray(files) || !files.length) throw new Error('sillytavern_chats_required');
  if (files.length > MAX_SILLYTAVERN_CHAT_FILES) throw new Error('sillytavern_chats_too_many_files');
  const decodedBytes = files.reduce((sum, file) => sum + decodeFile(file).length, 0);
  if (decodedBytes > MAX_SILLYTAVERN_CHAT_TOTAL_BYTES) throw new Error('sillytavern_chats_total_too_large');
};

export const previewSillyTavernChats = (userId: number, files: SillyTavernChatFile[], options: { sourceScope?: string } = {}): SillyTavernChatPreview[] => {
  const accountId = resolveAccountId(userId);
  validateBatch(files);
  return files.map(file => {
    const parsed = parseChat(file);
    if (options.sourceScope) parsed.hash = createHash('sha256').update(options.sourceScope + '\0' + parsed.hash).digest('hex');
    return previewParsed(accountId, parsed);
  });
};

export const importSillyTavernChats = (userId: number, files: SillyTavernChatFile[], options: { sourceScope?: string } = {}) => {
  const accountId = resolveAccountId(userId);
  validateBatch(files);
  return files.map(file => {
    const parsed = parseChat(file);
    if (options.sourceScope) parsed.hash = createHash('sha256').update(options.sourceScope + '\0' + parsed.hash).digest('hex');
    const preview = previewParsed(accountId, parsed);
    if (preview.already_imported_chat_id) {
      return { file_name: parsed.fileName, chat_id: preview.already_imported_chat_id, status: 'existing' as const, message_count: preview.message_count };
    }
    return db.transaction(() => {
      const prompt = findPrompt(accountId, parsed.characterName);
      const persona = findPersona(accountId, parsed);
      const chatId = createUserChat(accountId, parsed.title);
      const insert = db.prepare(`
        INSERT INTO chat_messages (
          user_id, role, content, chat_id, reasoning_content, token_count, reasoning_tokens,
          prompt_id, prompt_name, timeline_index, created_at, active_variant_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      parsed.messages.forEach((message, index) => {
        const inserted = insert.run(
          accountId, message.role, message.content, chatId, message.reasoning,
          countTokens(message.content), countTokens(message.reasoning || ''),
          message.role === 'assistant' ? prompt?.id ?? null : null,
          message.role === 'assistant' ? (message.name || prompt?.name || parsed.characterName || null) : null,
          index + 1, message.createdAt, message.role === 'assistant' ? message.activeVariantIndex : 0,
        );
        if (message.role === 'assistant') {
          const messageId = Number(inserted.lastInsertRowid);
          const insertVariant = db.prepare(`
            INSERT INTO chat_message_variants (
              message_id, variant_index, content, reasoning_content,
              prompt_id, prompt_name, token_count, reasoning_tokens, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          message.variants.forEach((content, variantIndex) => {
            const isActive = variantIndex === message.activeVariantIndex;
            insertVariant.run(
              messageId,
              variantIndex,
              content,
              isActive ? message.reasoning : null,
              prompt?.id ?? null,
              message.name || prompt?.name || parsed.characterName || null,
              countTokens(content),
              isActive ? countTokens(message.reasoning || '') : 0,
              message.createdAt,
            );
          });
        }
      });
      const firstDate = parsed.messages[0].createdAt;
      const lastDate = parsed.messages[parsed.messages.length - 1].createdAt;
      db.prepare('UPDATE user_chats SET default_prompt_id = ?, created_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(prompt?.id ?? null, firstDate, lastDate, chatId, accountId);
      if (persona) {
        getChatMemorySettings(accountId, chatId);
        updateChatMemorySettings(accountId, chatId, { persona_override_id: persona.id });
      }
      db.prepare(`
        INSERT INTO sillytavern_chat_imports (
          user_id, chat_id, source_file_name, source_hash, character_name, user_name, header_json, raw_jsonl, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(accountId, chatId, parsed.fileName, parsed.hash, parsed.characterName, parsed.userName, JSON.stringify(parsed.header), parsed.raw, getNowUnix());
      return { file_name: parsed.fileName, chat_id: chatId, status: 'created' as const, message_count: parsed.messages.length };
    })();
  });
};
