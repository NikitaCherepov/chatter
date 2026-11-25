import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  ts = require('typescript');
const { ThemeSettingsController } = require('../src/renderer/lib/theme-settings-controller.ts');
const {
  settingsOperations,
  parseSettingsRequest,
} = require('../src/main/settings-request-types.ts');
const schema = require('../src/renderer/lib/message-questionnaires.ts');
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const compile = (file: string) =>
  ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const states: any = { 1: { text: 'Original' }, 2: { text: 'Second' } };
const rows = new Map<string, any>(),
  calls: any[] = [];
let revision = 0,
  changed = 0,
  failDraft = false,
  pending: Promise<void> | undefined;
const form = {
  id: 'preferences',
  title: 'Preferences',
  questions: [
    {
      id: 'style',
      label: 'Style',
      type: 'single',
      required: true,
      options: ['Concise', 'Detailed'],
    },
    {
      id: 'topics',
      label: 'Topics',
      type: 'multiple',
      required: false,
      options: ['Code', 'Art'],
      allowOther: true,
    },
    { id: 'note', label: 'Anything else?', type: 'textarea', required: false },
  ],
};
const read = (id: number) => ({
  ...states[id],
  enabled: true,
  mode: 'both',
  surveys: [...rows.values()]
    .filter((s) => s.target_id === id)
    .reverse()
    .map(copy),
});
const survey = (id: number, base: string) => {
  const row = {
    id: 'survey_' + ++revision,
    scope: 'persona',
    target_id: id,
    questionnaire: copy(form),
    answers: null,
    draft: null,
    applied_text: null,
    created_at: 123,
    include_history: false,
    personalize: false,
    model_id: null,
    base_instructions: base,
    private_evidence: 'never expose',
  };
  rows.set(row.id, row);
  return row;
};
const apiFetch = async (path: string, options: any = {}) => {
  calls.push([path, options]);
  const body = options.body ? JSON.parse(options.body) : {};
  if (!options.method)
    return read(Number(new URL('https://fixture' + path).searchParams.get('target_id')));
  if (options.method === 'PATCH') {
    assert.equal(body.scope, 'persona');
    assert.equal(body.mode, 'both');
    if (states[body.target_id].text !== body.expected)
      throw Object.assign(new Error('conflict'), { data: { error: 'instructions_changed' } });
    states[body.target_id].text = body.text.trim();
    return { text: states[body.target_id].text, enabled: true, mode: 'both' };
  }
  if (path === '/api/v1/player-instructions/surveys') {
    assert.equal(body.scope, 'persona');
    assert.equal(body.include_history, false);
    return { survey: copy(survey(body.target_id, body.current_text)) };
  }
  const match = /\/surveys\/([^/]+)(?:\/(answers|regenerate|follow-up|apply))?$/.exec(path)!;
  const row = rows.get(match[1]);
  if (!row) throw new Error('survey_not_found');
  const state = states[row.target_id];
  if (options.method === 'DELETE') {
    if (body.remove_applied && row.applied_text !== null) {
      if (state.text !== row.applied_text) throw new Error('instructions_changed');
      state.text = row.base_instructions;
    }
    rows.delete(row.id);
    return { text: state.text, enabled: true, mode: 'both' };
  }
  if (match[2] === 'apply') {
    if (row.draft === null) throw new Error('survey_not_answered');
    if (state.text !== (row.applied_text ?? row.base_instructions))
      throw new Error('instructions_changed');
    state.text = body.text.trim();
    row.applied_text = state.text;
    return { text: state.text, enabled: true, mode: 'both' };
  }
  if (match[2] === 'follow-up') {
    if (!row.answers) throw new Error('survey_not_answered');
    return { survey: copy(survey(row.target_id, state.text)) };
  }
  if (match[2] === 'answers') {
    if (row.answers && JSON.stringify(row.answers) !== JSON.stringify(body.answers))
      throw new Error('survey_already_answered');
    row.answers = copy(body.answers);
  } else if (!row.answers) throw new Error('survey_not_answered');
  if (pending) await pending;
  if (failDraft) throw new Error('quota_exceeded');
  row.draft = 'Generated proposal';
  return { survey: copy(row) };
};
const service: any = { exports: {} };
vm.runInNewContext(compile('../src/renderer/lib/player-instructions-api.ts'), {
  exports: service.exports,
  require: () => ({ apiFetch }),
});
const module: any = { exports: {} };
vm.runInNewContext(compile('../src/renderer/lib/theme-persona-instructions.ts'), {
  exports: module.exports,
  require: (name: string) => (name === './player-instructions-api' ? service.exports : schema),
});
const handler = module.exports.createPersonaInstructionRequests({
  requirePersona: (id: number) => {
    if (![1, 2].includes(id)) throw new Error('settings_entity_unavailable');
  },
  validateModel: (id: unknown) => {
    if (id !== undefined && id !== null && id !== 'model')
      throw new Error('settings_entity_unavailable');
  },
  changed: async () => {
    changed++;
  },
});
const controller = new ThemeSettingsController({
  catalog: {
    groups: [],
    sections: [{ id: 'personas', groupId: '', label: 'Personas', mode: 'fields' }],
  },
  sections: {
    personas: {
      fields: () => [],
      groups: () => [],
      links: () => [],
      read: async () => ({}),
      write: async () => {},
      requests: () => settingsOperations('personas', (key: string) => key),
      request: handler,
    },
  },
  search: () => [],
  error: (code: string) => code,
});
await controller.handle({ type: 'settingsAction', action: 'open', sectionId: 'personas' });
let sequence = 0;
const raw = (operation: string, params: any) => ({
  method: 'settings',
  sectionId: 'personas',
  operation,
  params,
  requestId: String(++sequence),
  editorId: controller.getState().editor.id,
});
const request = async (operation: string, params: any) => {
  const input = raw(operation, params);
  try {
    return await controller.request(input);
  } finally {
    controller.completeRequest(input.requestId);
  }
};
await assert.rejects(request('getPersonaInstructions', { id: 999 }), /settings_entity_unavailable/);
await assert.rejects(
  request('savePersonaInstructions', { id: 1, text: 'No read' }),
  /settings_read_required/,
);
assert.equal(parseSettingsRequest(raw('createPersonaSurvey', { id: 1, questionCount: 101 })), null);
assert.equal(
  parseSettingsRequest(
    raw('deletePersonaSurvey', { id: 1, surveyId: 'survey_1', removeApplied: false }),
  ),
  null,
);
assert.equal(
  parseSettingsRequest(raw('applyPersonaSurvey', { id: 1, surveyId: '../bad', text: 'x' })),
  null,
);
let data = await request('getPersonaInstructions', { id: 1 });
assert.equal(data.text, 'Original');
data = await request('savePersonaInstructions', {
  id: 1,
  text: '  Saved  ',
  expected: 'ignored',
  mode: 'off',
});
assert.equal(data.text, 'Saved');
assert.equal(data.mode, 'both');
states[1].text = 'External edit';
await assert.rejects(
  request('savePersonaInstructions', { id: 1, text: 'Stale' }),
  /instructions_changed/,
);
await assert.rejects(
  request('savePersonaInstructions', { id: 1, text: 'Stale again' }),
  /settings_read_required/,
);
await request('getPersonaInstructions', { id: 1 });
await assert.rejects(
  request('createPersonaSurvey', { id: 1, modelId: 'foreign' }),
  /settings_entity_unavailable/,
);
const created = await request('createPersonaSurvey', {
  id: 1,
  brief: 'Preferences',
  questionCount: 4,
  scope: 'chat',
  target_id: 900,
  includeHistory: true,
});
const first = created.survey;
assert.equal(first.private_evidence, undefined);
assert.equal(first.base_instructions, undefined);
assert.equal(first.scope, 'persona');
assert.equal(
  states[1].text,
  'External edit',
  'creating a questionnaire never applies instructions',
);
const payload = JSON.parse(
  calls.find((c) => c[0] === '/api/v1/player-instructions/surveys')[1].body,
);
assert.equal(payload.include_history, false);
assert.equal(payload.personalize, false);
assert.equal(payload.include_prompt, false);
assert.equal(payload.question_count, 4);
assert.equal(payload.current_text, 'External edit');
await request('getPersonaInstructions', { id: 2 });
await assert.rejects(
  request('applyPersonaSurvey', { id: 2, surveyId: first.id, text: 'Cross-target' }),
  /settings_entity_unavailable/,
);
const submitted = {
  style: 'Concise',
  topics: { other: 'Music', selected: ['Code'] },
  note: 'A note',
};
const before = calls.length;
await assert.rejects(
  request('answerPersonaSurvey', {
    id: 1,
    surveyId: first.id,
    answers: { style: 'Invalid option' },
  }),
  /questionnaire_invalid/,
);
assert.equal(calls.length, before);
failDraft = true;
await assert.rejects(
  request('answerPersonaSurvey', { id: 1, surveyId: first.id, answers: submitted }),
  /quota_exceeded/,
);
data = await request('getPersonaInstructions', { id: 1 });
assert.ok(data.surveys[0].answers);
assert.equal(data.surveys[0].draft, null, 'answers survive a generation failure');
failDraft = false;
const regenerated = await request('regeneratePersonaSurvey', { id: 1, surveyId: first.id });
assert.equal(regenerated.survey.draft, 'Generated proposal');
assert.equal(states[1].text, 'External edit');
const follow = await request('followUpPersonaSurvey', {
  id: 1,
  surveyId: first.id,
  brief: 'More about work',
});
assert.notEqual(follow.survey.id, first.id);
assert.equal(
  JSON.parse(calls.find((c) => c[0].endsWith('/follow-up'))[1].body).brief,
  'More about work',
);
data = await request('applyPersonaSurvey', {
  id: 1,
  surveyId: first.id,
  text: 'Reviewed proposal',
});
assert.equal(data.text, 'Reviewed proposal');
assert.equal(data.surveys.find((s: any) => s.id === first.id).applied_text, 'Reviewed proposal');
data = await request('deletePersonaSurvey', {
  id: 1,
  surveyId: first.id,
  removeApplied: false,
  confirmed: true,
});
assert.equal(data.text, 'Reviewed proposal');
const second = (
  await request('createPersonaSurvey', {
    id: 1,
    modelId: 'model',
    personalize: true,
    includePrompt: true,
  })
).survey;
await request('answerPersonaSurvey', { id: 1, surveyId: second.id, answers: submitted });
await request('applyPersonaSurvey', { id: 1, surveyId: second.id, text: 'Next' });
states[1].text = 'New independent edit';
await assert.rejects(
  request('deletePersonaSurvey', {
    id: 1,
    surveyId: second.id,
    removeApplied: true,
    confirmed: true,
  }),
  /instructions_changed/,
);
assert.ok(rows.has(second.id));
await request('getPersonaInstructions', { id: 1 });
states[1].text = 'Next';
data = await request('deletePersonaSurvey', {
  id: 1,
  surveyId: second.id,
  removeApplied: true,
  confirmed: true,
});
assert.equal(data.text, 'Reviewed proposal');
assert.ok(changed >= 5, 'save/apply/delete refresh the same native consumers');
const last = (await request('createPersonaSurvey', { id: 1 })).survey;
let release!: () => void;
pending = new Promise((resolve) => {
  release = resolve;
});
const inFlight = request('answerPersonaSurvey', { id: 1, surveyId: last.id, answers: submitted });
await Promise.resolve();
await Promise.resolve();
await assert.rejects(
  request('savePersonaInstructions', { id: 1, text: 'Concurrent write' }),
  /settings_request_unavailable/,
);
controller.dispose();
release();
await assert.rejects(inFlight, /settings_scope_changed/);
assert.equal(rows.get(last.id).draft, 'Generated proposal');
console.log(
  'PASS: native instruction CAS, persona/survey ownership, explicit context sharing, canonical answer validation, saved-answer recovery, regeneration/follow-up, explicit apply/delete/restore and late-mutation isolation',
);
