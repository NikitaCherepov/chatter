import { db } from '../db.js';
import {
  appendChatMessage,
  createUserChat,
  deleteUserChat,
  getUserById,
  resolvePromptForChat,
  updateChatPromptSettings,
} from './chats.js';
import {
  getPersona,
  resolvePersonaForChat,
  updateChatMemorySettings,
} from './memory-foundation.js';
import {
  getUserPromptById,
  parseUserPromptRowId,
  resolvePromptSelectionForUser,
} from './prompts.js';
import { getMediaAssetByUrl } from './media-assets.js';
import type { MessageImage } from '../types.js';

export type InitialChatImage = { promptId: number } | { personaId: number } | { url: string };
export type InitialChatMessage = { content?: string; images?: InitialChatImage[] };
export type ChatCreationOptions = {
  title?: string;
  promptId?: number | null;
  personaId?: number | null;
  firstMessage?: InitialChatMessage | null;
  activate?: boolean;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const promptId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id !== 0;
const personaId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
export function parseChatCreationOptions(input: unknown): ChatCreationOptions {
  if (!record(input)) throw new Error('bad_chat_options');
  if (
    (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 2000)) ||
    (input.prompt_id !== undefined && input.prompt_id !== null && !promptId(input.prompt_id)) ||
    (input.persona_id !== undefined && input.persona_id !== null && !personaId(input.persona_id)) ||
    (input.activate !== undefined && typeof input.activate !== 'boolean')
  )
    throw new Error('bad_chat_options');
  let firstMessage: InitialChatMessage | null | undefined;
  if (input.first_message === null) firstMessage = null;
  else if (input.first_message !== undefined) {
    const message = input.first_message;
    if (
      !record(message) ||
      (message.content !== undefined &&
        (typeof message.content !== 'string' || message.content.length > 2 * 1024 * 1024)) ||
      (message.images !== undefined &&
        (!Array.isArray(message.images) || message.images.length > 8))
    )
      throw new Error('bad_first_message');
    const images = (message.images as unknown[] | undefined)?.map((image) => {
      if (!record(image) || Object.keys(image).length !== 1) throw new Error('bad_first_message');
      if (promptId(image.prompt_id)) return { promptId: image.prompt_id as number };
      if (personaId(image.persona_id)) return { personaId: image.persona_id as number };
      if (
        typeof image.url === 'string' &&
        /^\/(?:api\/v1\/images|uploads)\/[^/?#\\]+$/.test(image.url)
      )
        return { url: image.url };
      throw new Error('bad_first_message');
    });
    firstMessage = { content: message.content as string | undefined, images };
  }
  return {
    title: input.title as string | undefined,
    promptId: input.prompt_id as number | null | undefined,
    personaId: input.persona_id as number | null | undefined,
    activate: input.activate as boolean | undefined,
    firstMessage,
  };
}

export const expandGreetingMacros = (text: string, character: string, persona: string) =>
  text.replace(/{{\s*char\s*}}/gi, () => character).replace(/{{\s*user\s*}}/gi, () => persona);

/** Resolve owned references, never fetch a URL supplied by a theme. */
function initialImages(userId: number, references: InitialChatImage[] = []): MessageImage[] {
  return references.map((reference) => {
    let url: string | null = null;
    if ('promptId' in reference) {
      const rowId = parseUserPromptRowId(reference.promptId);
      const prompt = rowId === null ? undefined : getUserPromptById(userId, rowId);
      if (!prompt) throw new Error('prompt_not_found');
      url = prompt.image_url;
    } else if ('personaId' in reference) {
      const persona = getPersona(userId, reference.personaId);
      if (!persona) throw new Error('persona_not_found');
      url = persona.image_url;
    } else {
      const asset = getMediaAssetByUrl(reference.url);
      if (!asset || asset.user_id !== userId) throw new Error('chat_image_unavailable');
      url = asset.local_url;
    }
    if (!url) throw new Error('chat_image_unavailable');
    return { url, type: 'user_photo' };
  });
}

export async function createConfiguredChat(userId: number, options: ChatCreationOptions = {}) {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (options.promptId !== undefined && options.promptId !== null)
    resolvePromptSelectionForUser(user, options.promptId);
  if (
    options.personaId !== undefined &&
    options.personaId !== null &&
    !getPersona(userId, options.personaId)
  )
    throw new Error('persona_not_found');
  const images = initialImages(userId, options.firstMessage?.images);
  const previousActive = (
    db.prepare('SELECT active_chat_id FROM users WHERE id = ?').get(userId) as {
      active_chat_id: number | null;
    }
  ).active_chat_id;
  const chatId = db.transaction(() => {
    const id = createUserChat(userId, options.title ?? '');
    if (options.promptId !== undefined) updateChatPromptSettings(userId, id, options.promptId);
    if (options.personaId !== undefined)
      updateChatMemorySettings(userId, id, { persona_override_id: options.personaId });
    if (options.activate === false)
      db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(previousActive, userId);
    return id;
  })();
  try {
    if (!options.firstMessage?.content?.trim() && !images.length)
      return { chatId, messageId: null };
    const prompt = resolvePromptForChat(getUserById(userId)!, chatId);
    const persona = resolvePersonaForChat(userId, chatId).persona;
    const content = expandGreetingMacros(
      options.firstMessage?.content?.trim() ?? '',
      prompt.name,
      persona.name,
    );
    const messageId =
      content || images.length
        ? await appendChatMessage(
            userId,
            chatId,
            'assistant',
            content,
            null,
            null,
            images.length ? images : null,
            null,
            null,
            null,
            null,
            { promptId: prompt.id, promptName: prompt.name },
          )
        : null;
    return { chatId, messageId };
  } catch (error) {
    const restoreActive =
      (
        db.prepare('SELECT active_chat_id FROM users WHERE id = ?').get(userId) as {
          active_chat_id: number | null;
        }
      )?.active_chat_id === chatId;
    deleteUserChat(userId, chatId);
    // Do not overwrite a newer activation performed while the async append was running.
    if (restoreActive)
      db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(previousActive, userId);
    throw error;
  }
}

/** Imported cards keep their greeting; ordinary and built-in prompts can start chats too. */
export async function startPromptChat(
  userId: number,
  id: number,
  options: Omit<ChatCreationOptions, 'promptId'> = {},
) {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  const prompt = resolvePromptSelectionForUser(user, id);
  let firstMessage = options.firstMessage;
  if (firstMessage === undefined) {
    const rowId = parseUserPromptRowId(id);
    const card =
      rowId === null
        ? undefined
        : (db
            .prepare('SELECT first_message FROM user_prompt_character_cards WHERE prompt_id = ?')
            .get(rowId) as { first_message: string } | undefined);
    if (card?.first_message?.trim()) firstMessage = { content: card.first_message };
  }
  return createConfiguredChat(userId, {
    ...options,
    title: options.title ?? prompt.name,
    promptId: id,
    firstMessage,
  });
}
