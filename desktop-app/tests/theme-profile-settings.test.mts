import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  ts = require('typescript');
const { ThemeSettingsController } = require('../src/renderer/lib/theme-settings-controller.ts');
const {
  parseSettingsRequest,
  settingsOperations,
  SETTINGS_REQUESTS,
} = require('../src/main/settings-request-types.ts');
const dictionary = require('../src/renderer/i18n/locales/en/translation.json');
const t = (key: string) =>
  key.split('.').reduce((value: any, part: string) => value?.[part], dictionary) ?? key;
for (const section of ['intuition', 'prompt', 'personas'])
  for (const operation of Object.values(SETTINGS_REQUESTS[section]) as any[]) {
    assert.notEqual(
      t(operation.key),
      operation.key,
      'every advertised operation has a localized label',
    );
  }
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const calls: any[] = [],
  invalidations: any[] = [],
  events: string[] = [];
let active = true,
  pendingRead: Promise<any> | undefined,
  pendingWrite: Promise<void> | undefined,
  readSignal: AbortSignal | undefined;
let library: any = {
  prompts: [{ id: 1, name: 'Built-in', description: 'Fixed', is_default: 1, internal: 'hidden' }],
  custom_prompts: [
    {
      id: -1001,
      name: 'Custom',
      description: 'Description',
      content: 'Original',
      image_url: '/api/v1/images/avatar.png',
      private: 'hidden',
    },
  ],
  selected_prompt_id: 1,
  custom_prompt_content: 'Legacy',
  max_custom_prompt_length: 5000,
  internal: 'hidden',
};
let personas: any[] = [
  {
    id: 1,
    name: 'Main',
    description: 'Primary',
    core_memory: 'Memory',
    user_instructions: 'Instructions',
    image_url: null,
    allow_core_memory_update: 1,
    is_primary: 1,
    is_default: 1,
    user_id: 4,
  },
  {
    id: 2,
    name: 'Other',
    description: 'Other',
    core_memory: 'Other memory',
    user_instructions: 'Other instructions',
    image_url: '/uploads/avatar.png',
    allow_core_memory_update: 0,
    is_primary: 0,
    is_default: 0,
    user_id: 4,
  },
];
const api: any = {
  apiFetch: async (path: string, options: any = {}) => {
    calls.push([path, options]);
    readSignal = options.signal;
    if (!options.method) {
      if (pendingRead) return pendingRead;
      return copy(path === '/api/v1/prompts' ? library : { personas });
    }
    const body = options.body ? JSON.parse(options.body) : {};
    if (pendingWrite) await pendingWrite;
    if (path.endsWith('/activate')) {
      const id = Number(path.split('/').at(-2));
      personas = personas.map((p) => ({ ...p, is_default: p.id === id ? 1 : 0 }));
      return {};
    }
    if (options.method === 'POST') {
      const persona = { ...personas[1], ...body, id: 3, is_default: 0, user_id: 4 };
      personas.push(persona);
      return { persona: copy(persona) };
    }
    const id = Number(path.split('/').at(-1));
    if (options.method === 'DELETE') {
      if (id === 1) throw new Error('persona_primary_delete');
      personas = personas.filter((p) => p.id !== id);
      return {};
    }
    const target = personas.find((p) => p.id === id);
    Object.assign(target, body, {
      allow_core_memory_update: body.allow_core_memory_update ? 1 : 0,
    });
    return { persona: copy(target) };
  },
  selectPrompt: async (id: number) => {
    calls.push(['select', id]);
    library.selected_prompt_id = id;
  },
  createCustomPrompt: async (input: any) => {
    calls.push(['createPrompt', input]);
    const id = -1002;
    library.custom_prompts.push({ ...input, id, image_url: null });
    library.selected_prompt_id = id;
    return { prompt_id: id };
  },
  updateCustomPromptById: async (id: number, input: any) => {
    calls.push(['updatePrompt', id, input]);
    Object.assign(
      library.custom_prompts.find((p: any) => p.id === id),
      input,
    );
  },
  deleteCustomPrompt: async (id: number) => {
    calls.push(['deletePrompt', id]);
    library.custom_prompts = library.custom_prompts.filter((p: any) => p.id !== id);
    if (library.selected_prompt_id === id) library.selected_prompt_id = 1;
  },
  generatePrompt: async (input: any) => {
    calls.push(['generate', input]);
    return { generated_prompt: 'Proposal', private: 'hidden' };
  },
  setCustomPromptImage: async (id: number, input: any) => {
    calls.push(['promptImage', id, input]);
  },
  deleteCustomPromptImage: async (id: number) => {
    calls.push(['deletePromptImage', id]);
  },
  setPersonaImage: async (id: number, input: any) => {
    calls.push(['personaImage', id, input]);
  },
  deletePersonaImage: async (id: number) => {
    calls.push(['deletePersonaImage', id]);
  },
  resolveImageUrl: (path: string) => 'https://fixture.invalid' + path + '?token=private',
};
let imageMode: 'ok' | 'bad-type' | 'large' = 'ok',
  imageFetches = 0;
const module: any = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      new URL('../src/renderer/lib/theme-profile-settings.ts', import.meta.url),
      'utf8',
    ),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText,
  {
    exports: module.exports,
    Blob,
    Event,
    window: { dispatchEvent: (event: Event) => events.push(event.type) },
    fetch: async (url: string, options: any) => {
      imageFetches++;
      assert.equal(url, 'https://fixture.invalid/api/v1/images/avatar.png?token=private');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      return new Response(
        imageMode === 'large' ? new Uint8Array(10 * 1024 * 1024 + 1) : new Uint8Array([1, 2, 3]),
        { headers: { 'content-type': imageMode === 'bad-type' ? 'text/html' : 'image/png' } },
      );
    },
    require: (name: string) => {
      if (name === './api') return api;
      if (name.endsWith('settings-request-types')) return { settingsOperations };
      if (name === './attachment-files')
        return {
          fileToBase64: async (blob: Blob) =>
            'data:' +
            blob.type +
            ';base64,' +
            Buffer.from(await blob.arrayBuffer()).toString('base64'),
        };
      throw new Error(name);
    },
  },
);
const adapters = module.exports.createThemeProfileRequests({
  client: { invalidateQueries: async (input: any) => invalidations.push(input.queryKey) },
  base: 'fixture',
  userId: 4,
  current: () => active,
  t,
});
const controller = new ThemeSettingsController({
  catalog: {
    groups: [],
    sections: Object.keys(adapters).map((id) => ({ id, label: id, groupId: '', mode: 'hybrid' })),
  },
  sections: Object.fromEntries(
    Object.entries(adapters).map(([id, adapter]) => [
      id,
      {
        ...adapter,
        groups: () => [],
        fields: () => [],
        links: () => [],
        read: async () => ({}),
        write: async () => {
          throw new Error('no_fields');
        },
      },
    ]),
  ),
  search: () => [],
  error: (code: string) => code,
});
const open = (sectionId: string) =>
  controller.handle({ type: 'settingsAction', action: 'open', sectionId });
let sequence = 0;
const raw = (sectionId: string, operation: string, params: any = {}) => ({
  method: 'settings',
  requestId: String(++sequence),
  sectionId,
  operation,
  params,
  editorId: controller.getState().editor.id,
});
const request = async (sectionId: string, operation: string, params: any = {}) => {
  const input = raw(sectionId, operation, params);
  try {
    return await controller.request(input);
  } finally {
    controller.completeRequest(input.requestId);
  }
};
await open('prompt');
await assert.rejects(
  request('prompt', 'updatePrompt', { id: -1001, name: 'x', content: 'y' }),
  /settings_read_required/,
);
assert.equal(
  parseSettingsRequest(raw('prompt', 'updatePrompt', { id: 1, name: 'No', content: 'No' })),
  null,
);
assert.equal(parseSettingsRequest(raw('prompt', 'selectPrompt', { id: '1' })), null);
assert.equal(parseSettingsRequest(raw('prompt', 'deletePrompt', { id: -1001 })), null);
assert.equal(
  parseSettingsRequest(
    raw('personas', 'createPersona', {
      name: 'x',
      description: '',
      coreMemory: '',
      allowCoreMemoryUpdate: true,
      userInstructions: 'x'.repeat(12001),
    }),
  ),
  null,
);
let result = await request('prompt', 'listPrompts');
assert.equal(result.max_custom_prompt_length, 5000);
assert.equal(result.internal, undefined);
assert.equal(result.custom_prompts[0].private, undefined);
assert.equal(result.prompts[0].internal, undefined);
await assert.rejects(request('prompt', 'selectPrompt', { id: 999 }), /settings_entity_unavailable/);
await request('prompt', 'selectPrompt', { id: -1001 });
assert.equal(library.selected_prompt_id, -1001, 'negative IDs reach native calls unchanged');
const original = copy(library);
assert.equal(
  (
    await request('prompt', 'generatePrompt', {
      instruction: 'Make a proposal',
      currentContent: 'Original',
      detail: 'minimal',
    })
  ).generated_prompt,
  'Proposal',
);
assert.deepEqual(library, original, 'generation never saves or selects');
assert.equal(calls.at(-1)[1].current_content, 'Original');
library.custom_prompts[0].content = 'Outside change';
const writes = calls.filter((c) => c[0] === 'updatePrompt').length;
await assert.rejects(
  request('prompt', 'updatePrompt', { id: -1001, name: 'x', content: 'stale' }),
  /settings_entity_changed/,
);
assert.equal(calls.filter((c) => c[0] === 'updatePrompt').length, writes);
await request('prompt', 'listPrompts');
await request('prompt', 'updatePrompt', {
  id: -1001,
  name: 'Renamed',
  description: 'New',
  content: 'Edited',
  unexpected: 'must not forward',
});
assert.equal(library.custom_prompts[0].content, 'Edited');
assert.equal(calls.find((c) => c[0] === 'updatePrompt')[2].unexpected, undefined);
result = await request('prompt', 'getPromptImageSource', { id: -1001 });
assert.equal(result.source, 'data:image/png;base64,AQID');
assert.ok(!JSON.stringify(result).includes('private'));
imageMode = 'bad-type';
await assert.rejects(
  request('prompt', 'getPromptImageSource', { id: -1001 }),
  /settings_image_unavailable/,
);
imageMode = 'large';
await assert.rejects(
  request('prompt', 'getPromptImageSource', { id: -1001 }),
  /settings_image_too_large/,
);
imageMode = 'ok';
library.custom_prompts[0].image_url = 'https://arbitrary.invalid/avatar';
await request('prompt', 'listPrompts');
const fetches = imageFetches;
await assert.rejects(
  request('prompt', 'getPromptImageSource', { id: -1001 }),
  /settings_image_unavailable/,
);
assert.equal(imageFetches, fetches);
await request('prompt', 'setPromptImage', { id: -1001, base64: 'AQID', mimeType: 'image/png' });
assert.equal(calls.find((c) => c[0] === 'promptImage')[2].mime_type, 'image/png');
result = await request('prompt', 'createPrompt', {
  name: 'New',
  description: 'New',
  content: 'Text',
});
assert.equal(result.createdId, -1002);
assert.equal(
  result.selected_prompt_id,
  -1002,
  'create has the same auto-select behavior as native settings',
);
await request('prompt', 'deletePrompt', { id: -1002, confirmed: true });
assert.equal(library.selected_prompt_id, 1);
await request('prompt', 'selectPrompt', { id: -1 });
assert.equal(library.selected_prompt_id, -1, 'legacy prompt remains selectable');
assert.ok(invalidations.some((k) => k[0] === 'settings' && k[3] === 'prompts'));
assert.ok(invalidations.some((k) => k[0] === 'chat-prompt'));
await open('personas');
result = await request('personas', 'listPersonas');
assert.equal(result.personas[0].user_id, undefined);
assert.equal(result.personas[0].active, true);
assert.equal(result.personas[1].allowCoreMemoryUpdate, false);
const personaInput = {
  name: 'New persona',
  description: 'New description',
  coreMemory: 'Private memory',
  allowCoreMemoryUpdate: false,
};
result = await request('personas', 'createPersona', {
  ...personaInput,
  userInstructions: 'Preserved instructions',
});
assert.equal(result.createdId, 3);
assert.equal(result.personas.find((p: any) => p.id === 3).active, false);
assert.equal(result.personas[0].active, true);
await request('personas', 'activatePersona', { id: 3 });
assert.equal(personas.find((p) => p.id === 3).is_default, 1);
await request('personas', 'updatePersona', { id: 3, ...personaInput, coreMemory: 'Changed' });
assert.equal(
  personas.find((p) => p.id === 3).user_instructions,
  'Preserved instructions',
  'omitted instructions survive update',
);
assert.equal(personas.find((p) => p.id === 3).allow_core_memory_update, 0);
await assert.rejects(
  request('personas', 'updatePersona', { id: 999, ...personaInput }),
  /settings_entity_unavailable/,
);
personas[1].core_memory = 'Automated update';
await assert.rejects(
  request('personas', 'updatePersona', { id: 2, ...personaInput }),
  /settings_entity_changed/,
);
await request('personas', 'listPersonas');
result = await request('personas', 'getPersonaImageSource', { id: 2 });
assert.equal(
  result.source,
  'data:image/png;base64,AQID',
  'legacy avatar routes resolve through the host',
);
await request('personas', 'updatePersona', {
  id: 2,
  ...personaInput,
  userInstructions: 'Explicit new instructions',
});
assert.equal(personas[1].user_instructions, 'Explicit new instructions');
await assert.rejects(
  request('personas', 'deletePersona', { id: 1, confirmed: true }),
  /persona_primary_delete/,
);
await request('personas', 'deletePersona', { id: 3, confirmed: true });
assert.equal(
  personas.some((p) => p.id === 3),
  false,
);
assert.ok(events.includes('chatter:personas-changed'));
assert.ok(invalidations.some((k) => k[0] === 'memory-personas'));
// Cancellation invalidates read results and no late read is published into the new section.
let release!: (value: any) => void;
pendingRead = new Promise((resolve) => {
  release = resolve;
});
const late = request('personas', 'listPersonas');
await Promise.resolve();
const observed = readSignal;
await open('prompt');
assert.equal(observed?.aborted, true);
pendingRead = undefined;
release({ personas: copy(personas) });
await assert.rejects(late, /settings_scope_changed/);
// A mutation already submitted on this server can complete after the editor closes.
await open('personas');
await request('personas', 'listPersonas');
let releaseWrite!: () => void;
pendingWrite = new Promise((resolve) => {
  releaseWrite = resolve;
});
const lateWrite = request('personas', 'activatePersona', { id: 2 });
await Promise.resolve();
controller.dispose();
releaseWrite();
await assert.rejects(lateWrite, /settings_scope_changed/);
pendingWrite = undefined;
assert.equal(personas.find((p) => p.id === 2).is_default, 1);
assert.ok(events.length >= 1);
active = false;
await assert.rejects(
  adapters.prompt.request('listPrompts', {}, () => true, new AbortController().signal),
  /settings_scope_changed/,
);
console.log(
  'PASS: profile request validation, exact prompt IDs, explicit saves/generation, persona activation/deletion, stale-write detection, shared native cache/events, avatar isolation and canceled scopes',
);
