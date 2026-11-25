import type { QueryClient } from '@tanstack/react-query';
import * as api from './api';
import { settingsOperations } from '../../main/settings-request-types';
import type { ThemeSettingsSectionAdapter } from './theme-settings-controller';
import type { SettingsTranslate } from './settings-fields';
import { fileToBase64 } from './attachment-files';
import { cropProfileImage, type ProfileCrop } from './profile-image-crop';
import {
  parsePromptSections,
  serializePromptSections,
  type PromptSections,
} from './promptSections';
import { createPersonaInstructionRequests } from './theme-persona-instructions';

type Persona = {
  id: number;
  name: string;
  description: string;
  core_memory: string;
  user_instructions?: string;
  image_url: string | null;
  allow_core_memory_update: number;
  is_primary: number;
  is_default: number;
};
type Context = {
  client: QueryClient;
  base: string;
  userId: number | undefined;
  current: () => boolean;
  t: SettingsTranslate;
  chatCreated?: (id: number) => void;
};
type Adapter = Pick<ThemeSettingsSectionAdapter, 'requests' | 'request'>;
const publicPersona = (item: Persona) => ({
  id: item.id,
  name: item.name,
  description: item.description,
  coreMemory: item.core_memory,
  userInstructions: item.user_instructions ?? '',
  imageUrl: item.image_url,
  allowCoreMemoryUpdate: item.allow_core_memory_update === 1,
  primary: item.is_primary === 1,
  active: item.is_default === 1,
});
const publicPrompts = (library: api.PromptsResponse): api.PromptsResponse => ({
  prompts: library.prompts.map(({ id, name, description, is_default }) => ({
    id,
    name,
    description,
    is_default,
  })),
  custom_prompts: library.custom_prompts.map(
    ({ id, name, description, content, image_url, character_card }) => ({
      id,
      name,
      description,
      content,
      image_url,
      ...(character_card === undefined
        ? {}
        : {
            character_card: character_card
              ? { first_message_present: character_card.first_message_present }
              : null,
          }),
    }),
  ),
  selected_prompt_id: library.selected_prompt_id,
  custom_prompt_content: library.custom_prompt_content,
  ...(library.max_custom_prompt_length === undefined
    ? {}
    : { max_custom_prompt_length: library.max_custom_prompt_length }),
});

/** These forms call the same prompt/persona endpoints as native settings. */
export function createThemeProfileRequests(context: Context): Record<string, Adapter> {
  const { client, base, userId, current, t } = context;
  let prompts: api.PromptsResponse | null = null;
  let personas: Persona[] | null = null;
  let generationModels: Set<string> | null = null;
  const validateModel = (id: unknown) => {
    if (id !== undefined && id !== null && (!generationModels || !generationModels.has(String(id))))
      throw new Error('settings_entity_unavailable');
  };
  const scoped = (operationCurrent: () => boolean) => () => {
    if (!current() || !operationCurrent() || userId === undefined)
      throw new Error('settings_scope_changed');
  };
  const readPrompts = async (signal?: AbortSignal) =>
    api.apiFetch<api.PromptsResponse>('/api/v1/prompts', { signal });
  const readPersonas = async (signal?: AbortSignal) =>
    (await api.apiFetch<{ personas: Persona[] }>('/api/v1/memory/personas', { signal })).personas;
  const imageSource = async (url: string | null, guard: () => void, signal: AbortSignal) => {
    if (!url) return { source: null };
    const local = url.replace(/^\/uploads\//, '/api/v1/images/');
    if (!/^\/api\/v1\/images\/[^/?#]+$/.test(local)) throw new Error('settings_image_unavailable');
    const response = await fetch(api.resolveImageUrl(local), { signal, redirect: 'error' });
    guard();
    if (
      !response.ok ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
        response.headers.get('content-type')?.split(';')[0] ?? '',
      )
    )
      throw new Error('settings_image_unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('settings_image_unavailable');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 10 * 1024 * 1024) throw new Error('settings_image_too_large');
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    guard();
    const source = await fileToBase64(
      new Blob(parts as BlobPart[], { type: response.headers.get('content-type')! }),
    );
    guard();
    return { source };
  };
  const invalidate = async (section: string) => {
    if (!current()) return;
    if (section === 'prompt') {
      await client.invalidateQueries({ queryKey: ['settings', base, userId, 'prompts'] });
      await client.invalidateQueries({ queryKey: ['chat-prompt', base, userId] });
    } else {
      await client.invalidateQueries({ queryKey: ['memory-personas'] });
      await client.invalidateQueries({ queryKey: ['memory', base, userId] });
      if (current()) window.dispatchEvent(new Event('chatter:personas-changed'));
    }
  };
  const instructionRequests = createPersonaInstructionRequests({
    requirePersona: (id) => {
      if (!personas?.some((p) => p.id === id)) throw new Error('settings_entity_unavailable');
    },
    validateModel,
    changed: async (_id, guard, signal) => {
      await invalidate('personas');
      guard();
      const items = await readPersonas(signal);
      guard();
      personas = items;
    },
  });
  const shared = async (operation: string, params: Record<string, unknown>, guard: () => void) => {
    if (operation === 'listGenerationModels') {
      const data = await api.getModels();
      guard();
      generationModels = new Set(data.models.map((m) => m.id));
      return {
        result: {
          models: data.models.map(({ id, name }) => ({ id, name })),
          selectedId: data.preferred_model,
        },
      };
    }
    if (operation === 'cropProfileImage')
      return {
        result: await cropProfileImage(
          {
            base64: String(params.base64),
            mimeType: String(params.mimeType),
            crop: params.crop as ProfileCrop,
            outputSize: params.outputSize as number | undefined,
          },
          guard,
        ),
      };
    return null;
  };
  return {
    prompt: {
      requests: () => settingsOperations('prompt', t),
      request: async (operation, params, operationCurrent, signal) => {
        const guard = scoped(operationCurrent);
        guard();
        const common = await shared(operation, params, guard);
        guard();
        if (common) return common;
        if (operation === 'parsePromptSections')
          return { result: { sections: parsePromptSections(String(params.content)) } };
        if (operation === 'serializePromptSections')
          return {
            result: { content: serializePromptSections(params.sections as PromptSections) },
          };
        if (operation === 'listPrompts') {
          const data = await readPrompts(signal);
          guard();
          prompts = data;
          return { result: publicPrompts(data) };
        }
        if (operation === 'generatePrompt') {
          validateModel(params.modelId);
          const result = await api.generatePrompt({
            instruction: String(params.instruction),
            current_content: params.currentContent as string | undefined,
            detail: params.detail as 'minimal' | 'medium' | 'detailed' | 'none' | undefined,
            preferred_model: params.modelId as string | undefined,
          });
          guard();
          return { result: { generated_prompt: result.generated_prompt } };
        }
        const id = Number(params.id);
        if (operation !== 'createPrompt') {
          if (!prompts) throw new Error('settings_read_required');
          const known = prompts.custom_prompts.find((item) => item.id === id);
          const builtIn = prompts.prompts.some((item) => item.id === id);
          if (operation === 'selectPrompt') {
            if (!known && !builtIn && id !== -1) throw new Error('settings_entity_unavailable');
          } else if (!known) throw new Error('settings_entity_unavailable');
          if (operation === 'getPromptImageSource')
            return { result: await imageSource(known!.image_url, guard, signal) };
          if (operation === 'startPromptChat' && !known?.character_card)
            throw new Error('settings_entity_unavailable');
          if (known && operation !== 'selectPrompt') {
            const fresh = await readPrompts(signal);
            guard();
            if (
              JSON.stringify(fresh.custom_prompts.find((item) => item.id === id)) !==
              JSON.stringify(known)
            )
              throw new Error('settings_entity_changed');
          }
        }
        let createdId: number | undefined;
        if (operation === 'startPromptChat') {
          const result = await api.startCharacterCardChat(id);
          guard();
          return {
            result: { chatId: result.chat_id, messageId: result.message_id },
            afterReply: () => {
              if (current()) context.chatCreated?.(result.chat_id);
            },
          };
        }
        if (operation === 'selectPrompt') await api.selectPrompt(id);
        else if (operation === 'createPrompt')
          createdId = (
            await api.createCustomPrompt({
              name: String(params.name).trim(),
              description: params.description as string | undefined,
              content: String(params.content),
            })
          ).prompt_id;
        else if (operation === 'updatePrompt')
          await api.updateCustomPromptById(id, {
            name: String(params.name).trim(),
            description: params.description as string | undefined,
            content: String(params.content),
          });
        else if (operation === 'deletePrompt') await api.deleteCustomPrompt(id);
        else if (operation === 'setPromptImage')
          await api.setCustomPromptImage(id, {
            base64: String(params.base64),
            mime_type: String(params.mimeType),
          });
        else if (operation === 'deletePromptImage') await api.deleteCustomPromptImage(id);
        else throw new Error('settings_bad_request');
        await invalidate('prompt');
        guard();
        const data = await readPrompts(signal);
        guard();
        prompts = data;
        return {
          result: { ...publicPrompts(data), ...(createdId === undefined ? {} : { createdId }) },
        };
      },
    },
    personas: {
      requests: () => settingsOperations('personas', t),
      request: async (operation, params, operationCurrent, signal) => {
        const guard = scoped(operationCurrent);
        guard();
        const common = await shared(operation, params, guard);
        guard();
        if (common) return common;
        if (
          operation === 'getPersonaInstructions' ||
          operation === 'savePersonaInstructions' ||
          operation.endsWith('PersonaSurvey')
        )
          return instructionRequests(
            operation,
            params,
            () => {
              guard();
              return true;
            },
            signal,
          );
        if (operation === 'listPersonas') {
          const items = await readPersonas(signal);
          guard();
          personas = items;
          return { result: { personas: items.map(publicPersona) } };
        }
        const id = Number(params.id);
        if (operation !== 'createPersona') {
          const known = personas?.find((item) => item.id === id);
          if (!known) throw new Error('settings_entity_unavailable');
          if (operation === 'getPersonaImageSource')
            return { result: await imageSource(known.image_url, guard, signal) };
          if (operation !== 'activatePersona') {
            const fresh = await readPersonas(signal);
            guard();
            if (JSON.stringify(fresh.find((item) => item.id === id)) !== JSON.stringify(known))
              throw new Error('settings_entity_changed');
          }
        }
        let createdId: number | undefined;
        if (operation === 'createPersona' || operation === 'updatePersona') {
          const result = await api.apiFetch<{ persona: Persona }>(
            '/api/v1/memory/personas' + (operation === 'createPersona' ? '' : '/' + id),
            {
              method: operation === 'createPersona' ? 'POST' : 'PATCH',
              body: JSON.stringify({
                name: params.name,
                description: params.description,
                core_memory: params.coreMemory,
                allow_core_memory_update: params.allowCoreMemoryUpdate,
                ...(params.userInstructions === undefined
                  ? {}
                  : { user_instructions: params.userInstructions }),
              }),
            },
          );
          if (operation === 'createPersona') createdId = result.persona.id;
        } else if (operation === 'activatePersona')
          await api.apiFetch('/api/v1/memory/personas/' + id + '/activate', { method: 'POST' });
        else if (operation === 'deletePersona')
          await api.apiFetch('/api/v1/memory/personas/' + id, { method: 'DELETE' });
        else if (operation === 'setPersonaImage')
          await api.setPersonaImage(id, {
            base64: String(params.base64),
            mime_type: String(params.mimeType),
          });
        else if (operation === 'deletePersonaImage') await api.deletePersonaImage(id);
        else throw new Error('settings_bad_request');
        await invalidate('personas');
        guard();
        const items = await readPersonas(signal);
        guard();
        personas = items;
        return {
          result: {
            personas: items.map(publicPersona),
            ...(createdId === undefined ? {} : { createdId }),
          },
        };
      },
    },
  };
}
