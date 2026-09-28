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
import { importSillyTavernChats, previewSillyTavernChats, type SillyTavernChatFile } from './sillytavern-chat-import.js';

export const MAX_SILLYTAVERN_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_PERSONA_AVATAR_BYTES = 10 * 1024 * 1024;

type ArchiveFile = { name: string; data: Buffer };
type ParsedBackup = {
  characters: ArchiveFile[];
  chats: ArchiveFile[];
  settings: ArchiveFile | null;
  personaAvatars: ArchiveFile[];
  ignored: { group_chats: number; worlds: number; other: number };
  warnings: string[];
};

export type SillyTavernBackupPreview = {
  characters: { count: number; create_count: number; existing_count: number; names: string[] };
  personas: { count: number; create_count: number; update_count: number; avatar_count: number };
  chats: { count: number; create_count: number; existing_count: number; message_count: number };
  ignored: { group_chats: number; worlds: number; other: number };
  warnings: string[];
};

export type SillyTavernBackupImportResult = {
  characters: { created: number; existing: number };
  personas: { created: number; updated: number; avatars: number; avatar_errors: number };
  chats: { created: number; existing: number; message_count: number; chat_ids: number[] };
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

const classifyPath = (rawName: string): 'character' | 'chat' | 'settings' | 'persona_avatar' | 'group_chat' | 'world' | 'ignore' => {
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
  if (segmentIndex(parts, 'group chats') >= 0) return 'group_chat';
  if (segmentIndex(parts, 'worlds') >= 0) return 'world';
  return 'ignore';
};

const parseArchive = (buffer: Buffer): ParsedBackup => {
  if (!buffer.length) throw new Error('sillytavern_backup_required');
  if (buffer.length > MAX_SILLYTAVERN_BACKUP_BYTES) throw new Error('sillytavern_backup_too_large');
  let entryCount = 0;
  let extractedBytes = 0;
  const ignored = { group_chats: 0, worlds: 0, other: 0 };
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter(file) {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('sillytavern_backup_too_many_files');
        const kind = classifyPath(file.name);
        if (kind === 'group_chat') ignored.group_chats += 1;
        else if (kind === 'world') ignored.worlds += 1;
        else if (kind === 'ignore' && !file.name.endsWith('/')) ignored.other += 1;
        if (!['character', 'chat', 'settings', 'persona_avatar'].includes(kind)) return false;
        extractedBytes += Number(file.originalSize || 0);
        if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('sillytavern_backup_extracted_too_large');
        return true;
      },
    });
  } catch (error: any) {
    if (`${error?.message || ''}`.startsWith('sillytavern_backup_')) throw error;
    throw new Error('sillytavern_backup_invalid_zip');
  }
  const parsed: ParsedBackup = { characters: [], chats: [], settings: null, personaAvatars: [], ignored, warnings: [] };
  Object.entries(files).forEach(([rawName, data]) => {
    const name = normalizeArchivePath(rawName);
    const file = { name, data: Buffer.from(data) };
    const kind = classifyPath(name);
    if (kind === 'character') parsed.characters.push(file);
    if (kind === 'chat') parsed.chats.push(file);
    if (kind === 'persona_avatar') parsed.personaAvatars.push(file);
    if (kind === 'settings' && (!parsed.settings || name.split('/').length < parsed.settings.name.split('/').length)) parsed.settings = file;
  });
  if (ignored.group_chats) parsed.warnings.push('group_chats_not_supported');
  if (ignored.worlds) parsed.warnings.push('worlds_not_supported');
  if (ignored.other) parsed.warnings.push('other_data_ignored');
  if (!parsed.characters.length && !parsed.chats.length && !parsed.settings) throw new Error('sillytavern_backup_no_supported_data');
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

const chatFiles = (parsed: ParsedBackup): SillyTavernChatFile[] => parsed.chats.map(file => ({
  file_name: file.name,
  base64: file.data.toString('base64'),
}));

const chatBatches = (files: SillyTavernChatFile[]): SillyTavernChatFile[][] => {
  const batches: SillyTavernChatFile[][] = [];
  let batch: SillyTavernChatFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.from(file.base64, 'base64').length;
    if (batch.length && (batch.length >= 20 || bytes + size > 32 * 1024 * 1024)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
};

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

export const previewSillyTavernBackup = (userId: number, buffer: Buffer): SillyTavernBackupPreview => {
  const accountId = resolveAccountId(userId);
  const parsed = parseArchive(buffer);
  const cards = parsed.characters.map(file => parseCharacterCard({ fileName: file.name, data: file.data }));
  const characterExisting = cards.map(card => Boolean(findExistingCharacter(accountId, card.raw_json)));
  const payload = personaPayload(parsed.settings);
  const personas = payload ? previewSillyTavernPersonas(accountId, payload) : null;
  const avatars = avatarLookup(parsed);
  const chatPreviews = chatBatches(chatFiles(parsed)).flatMap(batch => previewSillyTavernChats(accountId, batch));
  const warnings = [...parsed.warnings];
  if (parsed.settings && !payload) warnings.push('personas_not_found');
  return {
    characters: {
      count: cards.length,
      create_count: characterExisting.filter(value => !value).length,
      existing_count: characterExisting.filter(Boolean).length,
      names: cards.map(card => toCharacterCardPreview(card).name),
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
    ignored: parsed.ignored,
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
  buffer: Buffer,
): Promise<SillyTavernBackupImportResult> => {
  const accountId = resolveAccountId(userId);
  const parsed = parseArchive(buffer);
  // Validate every supported item before the first write.
  previewSillyTavernBackup(accountId, buffer);
  const previousSelection = (db.prepare('SELECT selected_prompt_id FROM users WHERE id = ?')
    .get(accountId) as { selected_prompt_id: number | null } | undefined)?.selected_prompt_id ?? null;
  let createdCharacters = 0;
  let existingCharacters = 0;
  try {
    for (const file of parsed.characters) {
      const card = parseCharacterCard({ fileName: file.name, data: file.data });
      if (findExistingCharacter(accountId, card.raw_json)) {
        existingCharacters += 1;
      } else {
        await importCharacterCard(accountId, card);
        createdCharacters += 1;
      }
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
  if (payload) personaResult = importSillyTavernPersonas(accountId, payload);
  const personaAvatars = await importPersonaAvatars(accountId, parsed, personaResult.personas);

  const importedChats = chatBatches(chatFiles(parsed))
    .flatMap(batch => importSillyTavernChats(accountId, batch));
  const warnings = [...parsed.warnings];
  if (parsed.settings && !payload) warnings.push('personas_not_found');
  if (personaAvatars.errors) warnings.push('persona_avatar_errors');
  return {
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
      chat_ids: importedChats.map(chat => chat.chat_id),
    },
    warnings,
  };
};
