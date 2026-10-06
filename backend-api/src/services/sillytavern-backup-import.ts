import { unzipSync } from 'fflate';
import { db } from '../db.js';
import { resolveAccountId } from './accounts.js';
import { importCharacterCard, parseCharacterCard, toCharacterCardPreview } from './character-card-import.js';
import { getPersona, updatePersonaImage } from './memory-foundation.js';
import {
  attachMediaAsset,
  deleteMediaAssetIfUnreferenced,
  detachImageUrlFromEntity,
  getMediaAssetByUrl,
  saveImageAsset,
} from './media-assets.js';
import { importSillyTavernPersonas, previewSillyTavernPersonas } from './persona-import.js';
import { importSillyTavernChats, previewSillyTavernChats } from './sillytavern-chat-import.js';
import { VectorMemoryService } from './vector-memory.js';
import { attachmentReferences, chatMediaRows, findArchiveAttachment, importChatAttachments } from './sillytavern-chat-media.js';
import type { ArchiveEntry } from './sillytavern-archive-stream.js';
import { planGroupHistories, previewGroupHistory, importGroupHistory, groupCardRoot, missingGroupCards, type GroupCard } from './sillytavern-group-import.js';
import { toUserPromptSelectedId } from './prompts.js';

export const MAX_SILLYTAVERN_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_PERSONA_AVATAR_BYTES = 10 * 1024 * 1024;

type ArchiveFile = { name: string; data: Buffer };
type ParsedBackup = {
  characters: ArchiveFile[];
  chats: ArchiveFile[];
  groups: ArchiveFile[];
  groupChats: ArchiveFile[];
  settings: ArchiveFile | null;
  personaAvatars: ArchiveFile[];
  media: ArchiveEntry[];
  vectorCollections: Set<string>;
  ignored: { group_chats: number; worlds: number; other: number };
  warnings: string[];
};

export type SillyTavernBackupPreview = {
  groups: { count: number; history_count: number; create_count: number; existing_count: number; missing_cards: number };
  characters: { count: number; create_count: number; existing_count: number; names: string[] };
  personas: { count: number; create_count: number; update_count: number; avatar_count: number };
  chats: { count: number; create_count: number; existing_count: number; message_count: number };
  chat_memory: { chat_count: number; message_count: number };
  media: { images: number; files: number; missing: number; bytes: number };
  ignored: { group_chats: number; worlds: number; other: number };
  warnings: string[];
};

export type SillyTavernBackupImportResult = {
  groups: { created: number; existing: number };
  characters: { created: number; existing: number };
  personas: { created: number; updated: number; avatars: number; avatar_errors: number };
  chats: { created: number; existing: number; message_count: number; chat_ids: number[] };
  chat_memory: { detected: number; indexed: number; messages_indexed: number; messages_skipped: number; errors: number };
  media: { images: number; files: number; missing: number; errors: number };
  warnings: string[];
};

const normalizeArchivePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('sillytavern_backup_invalid_path');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(segment => segment === '..')) throw new Error('sillytavern_backup_invalid_path');
  return segments.join('/');
};

const pathParts = (name: string) => normalizeArchivePath(name).split('/');
const segmentIndex = (parts: string[], segment: string) => parts.findIndex(part => part.toLowerCase() === segment);

const vectorCollectionId = (rawName: string): string | null => {
  const parts = pathParts(rawName);
  const vectors = segmentIndex(parts, 'vectors');
  const leaf = parts.at(-1)?.toLowerCase() || '';
  if (vectors < 0 || vectors + 3 >= parts.length || leaf !== 'index.json') return null;
  return parts[vectors + 2] || null;
};

export const classifyBackupPath = (rawName: string): 'character' | 'chat' | 'settings' | 'persona_avatar' | 'media' | 'vector_index' | 'group' | 'group_chat' | 'world' | 'ignore' => {
  const parts = pathParts(rawName);
  const leaf = parts.at(-1)?.toLowerCase() || '';
  if (!leaf || rawName.endsWith('/')) return 'ignore';
  if (leaf === 'settings.json') return 'settings';
  const characters = segmentIndex(parts, 'characters');
  if (characters >= 0 && characters < parts.length - 1 && /\.(png|json)$/i.test(leaf)) return 'character';
  const chats = segmentIndex(parts, 'chats');
  if (chats >= 0 && chats < parts.length - 2 && leaf.endsWith('.jsonl')) return 'chat';
  const avatars = segmentIndex(parts, 'user avatars');
  if (avatars >= 0 && avatars < parts.length - 1 && /\.(png|jpe?g|webp|gif|avif)$/i.test(leaf)) return 'persona_avatar';
  if (vectorCollectionId(rawName)) return 'vector_index';
  if (segmentIndex(parts, 'groups') >= 0 && leaf.endsWith('.json')) return 'group';
  if (segmentIndex(parts, 'group chats') >= 0 && leaf.endsWith('.jsonl')) return 'group_chat';
  if (segmentIndex(parts, 'worlds') >= 0) return 'world';
  if (segmentIndex(parts, 'images') >= 0 || segmentIndex(parts, 'files') >= 0) return 'media';
  return 'ignore';
};
const classifyPath = classifyBackupPath;

const parseArchive = (input: Buffer | ArchiveEntry[]): ParsedBackup => {
  let entries: ArchiveEntry[];
  if (Array.isArray(input)) entries = input;
  else {
    if (!input.length) throw new Error('sillytavern_backup_required');
    if (input.length > MAX_SILLYTAVERN_BACKUP_BYTES) throw new Error('sillytavern_backup_too_large');
    const headers: Array<{ name: string; size: number }> = [];
    let extracted = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(input, { filter(file) {
        if (headers.length >= MAX_ARCHIVE_ENTRIES) throw new Error('sillytavern_backup_too_many_files');
        const name = normalizeArchivePath(file.name) + (file.name.endsWith('/') ? '/' : '');
        headers.push({ name, size: Number(file.originalSize || 0) });
        const supported = ['character', 'chat', 'settings', 'persona_avatar', 'media', 'group', 'group_chat'].includes(classifyPath(name));
        if (supported) extracted += Number(file.originalSize || 0);
        if (extracted > MAX_EXTRACTED_BYTES) throw new Error('sillytavern_backup_extracted_too_large');
        return supported;
      } });
    } catch (error: any) {
      if (error?.message?.startsWith('sillytavern_backup_')) throw error;
      throw new Error('sillytavern_backup_invalid_zip');
    }
    const normalizedFiles = new Map(Object.entries(files).map(([name, data]) => [normalizeArchivePath(name), data]));
    entries = headers.map(header => ({ ...header, data: Buffer.from(normalizedFiles.get(header.name) || []) }));
  }
  const parsed: ParsedBackup = { characters: [], chats: [], groups: [], groupChats: [], settings: null, personaAvatars: [], media: [], vectorCollections: new Set(), ignored: { group_chats: 0, worlds: 0, other: 0 }, warnings: [] };
  for (const file of entries) {
    const kind = classifyPath(file.name);
    if (kind === 'character') parsed.characters.push(file);
    else if (kind === 'chat') parsed.chats.push(file);
    else if (kind === 'group') parsed.groups.push(file);
    else if (kind === 'group_chat') parsed.groupChats.push(file);
    else if (kind === 'persona_avatar') parsed.personaAvatars.push(file);
    else if (kind === 'media') parsed.media.push(file);
    else if (kind === 'settings' && (!parsed.settings || file.name.split('/').length < parsed.settings.name.split('/').length)) parsed.settings = file;
    else if (kind === 'vector_index') parsed.vectorCollections.add(vectorCollectionId(file.name)!.toLowerCase());
    else if (kind === 'world') parsed.ignored.worlds++;
    else if (kind === 'ignore' && !file.name.endsWith('/')) parsed.ignored.other++;
  }
  if (parsed.ignored.worlds) parsed.warnings.push('worlds_not_supported');
  if (parsed.ignored.other) parsed.warnings.push('other_data_ignored');
  if (!parsed.characters.length && !parsed.chats.length && !parsed.groupChats.length && !parsed.settings) throw new Error('sillytavern_backup_no_supported_data');
  return parsed;
};
const personaPayload = (settings: ArchiveFile | null): string | null => {
  if (!settings) return null;
  let root: any;
  try { root = JSON.parse(settings.data.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('sillytavern_backup_invalid_settings'); }
  const powerUser = root?.power_user;
  if (!powerUser?.personas || typeof powerUser.personas !== 'object' || Array.isArray(powerUser.personas) || !Object.keys(powerUser.personas).length) return null;
  return Buffer.from(JSON.stringify({
    personas: powerUser.personas,
    persona_descriptions: powerUser.persona_descriptions || {},
    default_persona: powerUser.default_persona ?? null,
  })).toString('base64');
};

const chatCollectionId = (fileName: string) => pathParts(fileName).at(-1)!.replace(/\.jsonl$/i, '').toLowerCase();
const hasChatVectors = (parsed: ParsedBackup, fileName: string) => parsed.vectorCollections.has(chatCollectionId(fileName));

const findExistingCharacter = (userId: number, rawJson: string) => db.prepare(`
  SELECT prompt.id, prompt.name
  FROM user_prompt_character_cards card
  INNER JOIN user_prompts prompt ON prompt.id = card.prompt_id
  WHERE prompt.user_id = ? AND card.raw_json = ?
  ORDER BY prompt.id ASC LIMIT 1
`).get(userId, rawJson) as { id: number; name: string } | undefined;

const avatarLookup = (parsed: ParsedBackup): Map<string, ArchiveFile> => {
  const result = new Map<string, ArchiveFile>();
  parsed.personaAvatars.forEach(file => {
    const parts = pathParts(file.name);
    const index = segmentIndex(parts, 'user avatars');
    result.set(parts.slice(index + 1).join('/').toLowerCase(), file);
    result.set(parts.at(-1)!.toLowerCase(), file);
  });
  return result;
};

export const previewSillyTavernBackup = (userId: number, buffer: Buffer | ArchiveEntry[]): SillyTavernBackupPreview => {
  const accountId = resolveAccountId(userId);
  const parsed = parseArchive(buffer);
  const cards = parsed.characters.map(file => {
    const card = parseCharacterCard({ fileName: file.name, data: file.data });
    return { existing: Boolean(findExistingCharacter(accountId, card.raw_json)), name: toCharacterCardPreview(card).name };
  });
  const characterExisting = cards.map(card => card.existing);
  const payload = personaPayload(parsed.settings);
  const personas = payload ? previewSillyTavernPersonas(accountId, payload) : null;
  const avatars = avatarLookup(parsed);
  const chatPreviews = parsed.chats.flatMap(file => previewSillyTavernChats(accountId, [{ file_name: file.name, base64: file.data.toString('base64') }]));
  const groupTasks = planGroupHistories(parsed.groups, parsed.groupChats);
  const groupPreviews = groupTasks.map(task => previewGroupHistory(accountId, task));
  const cardKeys = parsed.characters.map(file => ({ root: groupCardRoot(file.name), key: file.name.slice(file.name.toLowerCase().lastIndexOf('/characters/') + 12) }));
  const missingCards = groupTasks.filter(task => missingGroupCards(task, cardKeys)).length;
  const media = { images: 0, files: 0, missing: 0, bytes: 0 };
  const mediaSeen = new Set<string>();
  for (const file of [...parsed.chats, ...parsed.groupChats]) {
    for (const row of chatMediaRows(file.data.toString('utf8'))) {
      for (const extra of [row.extra, ...(Array.isArray(row.swipe_info) ? row.swipe_info.map((swipe: any) => swipe?.extra) : [])]) {
        for (const ref of attachmentReferences(extra)) {
          const entry = findArchiveAttachment(parsed.media, ref.url);
          if (!entry) { media.missing++; continue; }
          media.bytes += entry.size;
          if (mediaSeen.has(entry.name)) continue;
          mediaSeen.add(entry.name);
          if (ref.image) media.images++; else media.files++;
        }
      }
    }
  }
  const previewFiles = [...parsed.chats, ...groupTasks.map(task => task.file)];
  const allPreviews = [...chatPreviews, ...groupPreviews];
  const vectorizedChatIndexes = previewFiles
    .map((file, index) => hasChatVectors(parsed, file.name) ? index : -1)
    .filter(index => index >= 0);
  const warnings = [...parsed.warnings];
  if (parsed.settings && !payload) warnings.push('personas_not_found');
  warnings.push(...new Set(groupTasks.flatMap(task => task.warnings)));
  if (missingCards) warnings.push('group_character_missing');
  return {
    groups: { count: parsed.groups.length, history_count: groupTasks.length, create_count: groupPreviews.filter(chat => !chat.already_imported_chat_id).length, existing_count: groupPreviews.filter(chat => chat.already_imported_chat_id).length, missing_cards: missingCards },
    characters: {
      count: cards.length,
      create_count: characterExisting.filter(value => !value).length,
      existing_count: characterExisting.filter(Boolean).length,
      names: cards.map(card => card.name),
    },
    personas: {
      count: personas?.count || 0,
      create_count: personas?.create_count || 0,
      update_count: personas?.update_count || 0,
      avatar_count: personas?.entries.filter(entry => avatars.has(entry.key.toLowerCase())).length || 0,
    },
    chats: {
      count: chatPreviews.length,
      create_count: chatPreviews.filter(chat => !chat.already_imported_chat_id).length,
      existing_count: chatPreviews.filter(chat => Boolean(chat.already_imported_chat_id)).length,
      message_count: chatPreviews.reduce((sum, chat) => sum + chat.message_count, 0),
    },
    chat_memory: {
      chat_count: vectorizedChatIndexes.length,
      message_count: vectorizedChatIndexes.reduce((sum, index) => sum + allPreviews[index].message_count, 0),
    },
    ignored: parsed.ignored,
    media,
    warnings,
  };
};

const importPersonaAvatars = async (
  userId: number,
  parsed: ParsedBackup,
  personas: Array<{ id: number; import_key: string | null }>,
) => {
  const avatars = avatarLookup(parsed);
  let imported = 0;
  let errors = 0;
  for (const persona of personas) {
    const avatar = persona.import_key ? avatars.get(persona.import_key.toLowerCase()) : null;
    if (!avatar) continue;
    if (!avatar.data.length || avatar.data.length > MAX_PERSONA_AVATAR_BYTES) {
      errors += 1;
      continue;
    }
    let savedAssetId: number | null = null;
    try {
      const existing = getPersona(userId, persona.id);
      const saved = await saveImageAsset({
        userId,
        data: avatar.data,
        retention: 'temporary',
        kind: 'persona_avatar',
        transform: 'thumbnail',
        metadata: { source: 'sillytavern_backup', source_file: avatar.name },
      });
      savedAssetId = saved.id;
      attachMediaAsset({ assetId: saved.id, entityType: 'persona', entityId: persona.id, slot: 'avatar' });
      updatePersonaImage(userId, persona.id, saved.url);
      if (existing?.image_url && existing.image_url !== saved.url) {
        const previous = getMediaAssetByUrl(existing.image_url);
        detachImageUrlFromEntity({ url: existing.image_url, entityType: 'persona', entityId: persona.id });
        if (previous) deleteMediaAssetIfUnreferenced(previous.id);
      }
      imported += 1;
    } catch {
      if (savedAssetId !== null) deleteMediaAssetIfUnreferenced(savedAssetId);
      errors += 1;
    }
  }
  return { imported, errors };
};

export const importSillyTavernBackup = async (
  userId: number,
  buffer: Buffer | ArchiveEntry[],
  options: { importChatMemory?: typeof VectorMemoryService.importChatFacts; onProgress?: (stage: string, done: number, total: number) => void } = {},
): Promise<SillyTavernBackupImportResult> => {
  const accountId = resolveAccountId(userId);
  const parsed = parseArchive(buffer);
  // Validate every supported item before the first write.
  previewSillyTavernBackup(accountId, buffer);
  const previousSelection = (db.prepare('SELECT selected_prompt_id FROM users WHERE id = ?')
    .get(accountId) as { selected_prompt_id: number | null } | undefined)?.selected_prompt_id ?? null;
  let createdCharacters = 0;
  let existingCharacters = 0;
  const groupCards: GroupCard[] = [];
  try {
    for (const file of parsed.characters) {
      options.onProgress?.('characters', createdCharacters + existingCharacters, parsed.characters.length);
      const card = parseCharacterCard({ fileName: file.name, data: file.data });
      if (findExistingCharacter(accountId, card.raw_json)) {
        existingCharacters += 1;
      } else {
        await importCharacterCard(accountId, card);
        createdCharacters += 1;
      }
      const prompt = findExistingCharacter(accountId, card.raw_json)!;
      groupCards.push({ root: groupCardRoot(file.name), key: file.name.slice(file.name.toLowerCase().lastIndexOf('/characters/') + 12), promptId: toUserPromptSelectedId(prompt.id), name: prompt.name });
    }
  } finally {
    db.prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?').run(previousSelection, accountId);
  }

  const payload = personaPayload(parsed.settings);
  let personaResult = {
    personas: [] as Array<{ id: number; import_key: string | null }>,
    created: 0,
    updated: 0,
  };
  options.onProgress?.('personas', 0, payload ? 1 : 0);
  if (payload) personaResult = importSillyTavernPersonas(accountId, payload);
  const personaAvatars = await importPersonaAvatars(accountId, parsed, personaResult.personas);

  const importedChats: ReturnType<typeof importSillyTavernChats> = [];
  const groupResults: ReturnType<typeof importGroupHistory>[] = [];
  const media = { images: 0, files: 0, missing: 0, errors: 0 };
  for (const file of parsed.chats) {
    options.onProgress?.('chats', importedChats.length, parsed.chats.length);
    const raw = file.data;
    const [chat] = importSillyTavernChats(accountId, [{ file_name: file.name, base64: raw.toString('base64') }]);
    importedChats.push(chat);
    const importedMedia = await importChatAttachments(accountId, chat.chat_id, raw.toString('utf8'), parsed.media, (done, total) => options.onProgress?.('media', done, total));
    for (const key of ['images', 'files', 'missing', 'errors'] as const) media[key] += importedMedia[key];
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const importChatMemory = options.importChatMemory || VectorMemoryService.importChatFacts.bind(VectorMemoryService);
  const groupTasks = planGroupHistories(parsed.groups, parsed.groupChats);
  for (const task of groupTasks) {
    options.onProgress?.('groups', groupResults.length, groupTasks.length);
    const imported = importGroupHistory(accountId, task, groupCards);
    groupResults.push(imported);
    const importedMedia = await importChatAttachments(accountId, imported.chat.chat_id, task.file.data.toString('utf8'), parsed.media, (done, total) => options.onProgress?.('media', done, total));
    for (const key of ['images', 'files', 'missing', 'errors'] as const) media[key] += importedMedia[key];
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const allFiles = [...parsed.chats, ...groupTasks.map(task => task.file)];
  const allImportedChats = [...importedChats, ...groupResults.map(result => result.chat)];
  const chatMemory = { detected: 0, indexed: 0, messages_indexed: 0, messages_skipped: 0, errors: 0 };
  for (let index = 0; index < allFiles.length; index += 1) {
    options.onProgress?.('memory', index, allFiles.length);
    if (!hasChatVectors(parsed, allFiles[index].name)) continue;
    chatMemory.detected += 1;
    const importedChat = allImportedChats[index];
    try {
      const rows = db.prepare(`
        SELECT role, content, prompt_name, timeline_index, created_at
        FROM chat_messages
        WHERE user_id = ? AND chat_id = ? AND role IN ('user', 'assistant')
        ORDER BY timeline_index ASC, id ASC
      `).all(accountId, importedChat.chat_id) as Array<{
        role: 'user' | 'assistant';
        content: string;
        prompt_name: string | null;
        timeline_index: number;
        created_at: number;
      }>;
      const result = await importChatMemory(accountId, importedChat.chat_id, rows.map(row => ({
        text: row.content,
        source: row.role === 'assistant' ? (row.prompt_name || 'character') : 'user',
        originMessageCursor: row.timeline_index,
        createdAt: row.created_at,
      })));
      chatMemory.indexed += 1;
      chatMemory.messages_indexed += result.imported;
      chatMemory.messages_skipped += result.skipped;
    } catch (error) {
      chatMemory.errors += 1;
      console.error('[sillytavern-backup] Chat memory import failed', {
        chat_id: importedChat.chat_id,
        source_file: allFiles[index].name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const warnings = [...parsed.warnings];
  if (parsed.settings && !payload) warnings.push('personas_not_found');
  if (personaAvatars.errors) warnings.push('persona_avatar_errors');
  if (chatMemory.errors) warnings.push('chat_vector_import_errors');
  if (media.missing) warnings.push('media_missing');
  if (media.errors) warnings.push('media_import_errors');
  warnings.push(...new Set(groupResults.flatMap(result => result.warnings)));
  return {
    groups: { created: groupResults.filter(result => result.chat.status === 'created').length, existing: groupResults.filter(result => result.chat.status === 'existing').length },
    characters: { created: createdCharacters, existing: existingCharacters },
    personas: {
      created: personaResult.created,
      updated: personaResult.updated,
      avatars: personaAvatars.imported,
      avatar_errors: personaAvatars.errors,
    },
    chats: {
      created: importedChats.filter(chat => chat.status === 'created').length,
      existing: importedChats.filter(chat => chat.status === 'existing').length,
      message_count: importedChats.reduce((sum, chat) => sum + chat.message_count, 0),
      chat_ids: allImportedChats.map(chat => chat.chat_id),
    },
    chat_memory: chatMemory,
    media,
    warnings,
  };
};
