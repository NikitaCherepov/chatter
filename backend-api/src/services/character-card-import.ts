import { db } from '../db.js';
import { createUserPrompt, deleteUserPrompt, toUserPromptSelectedId } from './prompts.js';
import { attachMediaAsset, deleteMediaAssetIfUnreferenced, removeMediaReferencesForEntity, saveImageAsset } from './media-assets.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_CHARACTER_CARD_BYTES = 12 * 1024 * 1024;
type JsonObject = Record<string, unknown>;

export type CharacterCardPreview = {
  source_format: 'json' | 'png'; spec: 'v1' | 'v2' | 'v3'; spec_version: string | null;
  name: string; description: string; content: string;
  sections: { description: string; personality: string; scenario: string; examples: string; other: string };
  has_avatar: boolean; avatar_data_url: string | null; first_message_present: boolean;
  alternate_greetings_count: number; group_greetings_count: number; has_character_book: boolean;
  asset_count: number; warnings: string[];
};

export type ParsedCharacterCard = CharacterCardPreview & {
  raw_json: string; first_message: string; alternate_greetings: string[]; group_only_greetings: string[];
  avatar: { data: Buffer; mimeType: string } | null;
};

const asObject = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const asString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const asStringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const parseDataImage = (value: string) => {
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) return null;
  const data = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!data.length || data.length > MAX_CHARACTER_CARD_BYTES) return null;
  return { data, mimeType: match[1].toLowerCase() };
};

const decodePngCard = (file: Buffer): unknown => {
  if (file.length < 8 || !file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('character_card_invalid_png');
  let offset = 8;
  let v3Payload: string | null = null;
  let legacyPayload: string | null = null;
  while (offset + 12 <= file.length) {
    const length = file.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > file.length) throw new Error('character_card_invalid_png');
    const type = file.toString('ascii', typeStart, dataStart);
    if (type === 'tEXt') {
      const chunk = file.subarray(dataStart, dataEnd);
      const separator = chunk.indexOf(0);
      if (separator > 0) {
        const keyword = chunk.toString('latin1', 0, separator);
        const value = chunk.toString('latin1', separator + 1).trim();
        if (keyword === 'ccv3') v3Payload = value;
        if (keyword === 'chara') legacyPayload = value;
      }
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  const encoded = v3Payload || legacyPayload;
  if (!encoded) throw new Error('character_card_png_payload_missing');
  try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('character_card_invalid_json'); }
};

const findEmbeddedAvatar = (data: JsonObject) => {
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const icon = assets.find(asset => {
    const item = asObject(asset);
    return item && asString(item.type).toLowerCase() === 'icon' && asString(item.name).toLowerCase() === 'main';
  });
  const uri = asString(asObject(icon)?.uri);
  if (!uri) return { avatar: null, warning: false };
  const avatar = parseDataImage(uri);
  return { avatar, warning: !avatar && !uri.toLowerCase().startsWith('ccdefault:') };
};

const composeSections = (data: JsonObject) => {
  const sections = { description: asString(data.description), personality: asString(data.personality), scenario: asString(data.scenario), examples: asString(data.mes_example), other: '' };
  const other: string[] = [];
  const systemPrompt = asString(data.system_prompt);
  const postHistory = asString(data.post_history_instructions);
  if (systemPrompt) other.push(`## SYSTEM PROMPT\n${systemPrompt}`);
  if (postHistory) other.push(`## POST-HISTORY INSTRUCTIONS\n${postHistory}`);
  sections.other = other.join('\n\n');
  const labels: Array<[keyof typeof sections, string]> = [['description', 'DESCRIPTION'], ['personality', 'PERSONALITY'], ['scenario', 'SCENARIO'], ['examples', 'EXAMPLES'], ['other', 'OTHER']];
  const content = labels.filter(([key]) => Boolean(sections[key])).map(([key, label]) => `# ${label}\n${sections[key]}`).join('\n\n');
  return { sections, content };
};

export const parseCharacterCard = (input: { fileName: string; mimeType?: string; data: Buffer }): ParsedCharacterCard => {
  if (!input.data.length) throw new Error('character_card_file_required');
  if (input.data.length > MAX_CHARACTER_CARD_BYTES) throw new Error('character_card_file_too_large');
  const png = input.mimeType === 'image/png' || input.fileName.toLowerCase().endsWith('.png');
  let parsed: unknown;
  if (png) parsed = decodePngCard(input.data);
  else {
    try { parsed = JSON.parse(input.data.toString('utf8')); }
    catch { throw new Error('character_card_invalid_json'); }
  }
  const root = asObject(parsed);
  if (!root) throw new Error('character_card_invalid_json');
  const declaredSpec = asString(root.spec).toLowerCase();
  const wrapped = asObject(root.data);
  const data = wrapped && (declaredSpec.includes('chara_card') || declaredSpec.includes('character_card')) ? wrapped : root;
  const spec: ParsedCharacterCard['spec'] = declaredSpec.includes('v3') ? 'v3' : declaredSpec.includes('v2') ? 'v2' : 'v1';
  const name = asString(data.name);
  if (!name) throw new Error('character_card_name_required');
  const { sections, content } = composeSections(data);
  if (!content) throw new Error('character_card_content_required');
  const alternateGreetings = asStringArray(data.alternate_greetings);
  const groupOnlyGreetings = asStringArray(data.group_only_greetings);
  const firstMessage = asString(data.first_mes);
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const embeddedAvatar = findEmbeddedAvatar(data);
  const avatar = png ? { data: input.data, mimeType: 'image/png' } : embeddedAvatar.avatar;
  const warnings: string[] = [];
  if (embeddedAvatar.warning) warnings.push('external_or_embedded_avatar_not_imported');
  if (asObject(data.character_book)) warnings.push('character_book_preserved_for_later');
  if (firstMessage || alternateGreetings.length || groupOnlyGreetings.length) warnings.push('greetings_preserved_for_later');
  if (assets.length > 0) warnings.push('additional_assets_preserved_for_later');
  const shortDescription = asString(data.creator_notes) || sections.description.replace(/\s+/g, ' ');
  const avatarDataUrl = avatar && !png ? `data:${avatar.mimeType};base64,${avatar.data.toString('base64')}` : null;
  return {
    source_format: png ? 'png' : 'json', spec, spec_version: asString(root.spec_version) || null, name,
    description: shortDescription.slice(0, 200), content, sections, has_avatar: Boolean(avatar), avatar_data_url: avatarDataUrl,
    first_message_present: Boolean(firstMessage), alternate_greetings_count: alternateGreetings.length,
    group_greetings_count: groupOnlyGreetings.length, has_character_book: Boolean(asObject(data.character_book)), asset_count: assets.length,
    warnings, raw_json: JSON.stringify(root), first_message: firstMessage, alternate_greetings: alternateGreetings,
    group_only_greetings: groupOnlyGreetings, avatar,
  };
};

export const toCharacterCardPreview = (card: ParsedCharacterCard): CharacterCardPreview => {
  const { raw_json: _raw, first_message: _first, alternate_greetings: _alternate, group_only_greetings: _group, avatar: _avatar, ...preview } = card;
  return preview;
};

export const importCharacterCard = async (userId: number, card: ParsedCharacterCard) => {
  let rowId: number | null = null;
  let assetId: number | null = null;
  try {
    rowId = db.transaction(() => {
      const created = createUserPrompt(userId, card.name, card.description, card.content);
      const id = Number(created.lastInsertRowid);
      db.prepare(`INSERT INTO user_prompt_character_cards (prompt_id, source_format, spec, spec_version, first_message, alternate_greetings_json, group_only_greetings_json, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, card.source_format, card.spec, card.spec_version, card.first_message, JSON.stringify(card.alternate_greetings), JSON.stringify(card.group_only_greetings), card.raw_json);
      return id;
    })();
    let imageUrl: string | null = null;
    if (card.avatar) {
      const saved = await saveImageAsset({ userId, data: card.avatar.data, retention: 'temporary', kind: 'prompt_avatar', transform: 'thumbnail', metadata: { source: 'character_card', spec: card.spec } });
      assetId = saved.id;
      imageUrl = saved.url;
      attachMediaAsset({ assetId: saved.id, entityType: 'user_prompt', entityId: rowId, slot: 'avatar' });
      db.prepare('UPDATE user_prompts SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(saved.url, rowId, userId);
    }
    const selectedId = toUserPromptSelectedId(rowId);
    db.prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?').run(selectedId, userId);
    return { promptId: selectedId, imageUrl };
  } catch (error) {
    if (rowId !== null) {
      const detached = removeMediaReferencesForEntity('user_prompt', rowId);
      deleteUserPrompt(userId, rowId);
      detached.forEach(deleteMediaAssetIfUnreferenced);
    }
    if (assetId !== null) deleteMediaAssetIfUnreferenced(assetId);
    throw error;
  }
};
