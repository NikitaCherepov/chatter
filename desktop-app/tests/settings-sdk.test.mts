import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SettingsFormStore, SettingsTask } = require('../src/interactive/settings-store.ts');
const { ThemeSettingsController } = require('../src/renderer/lib/theme-settings-controller.ts');
const { settingsOperations, canRequestSettings } = require('../src/main/settings-request-types.ts');
const {
  SETTINGS_REQUEST_DECLARATIONS,
} = require('../src/main/theme-settings-request-documentation.ts');
assert.equal(
  fs
    .readFileSync(new URL('../src/interactive/settings-contract.d.ts', import.meta.url), 'utf8')
    .split('\n')
    .slice(1)
    .join('\n'),
  SETTINGS_REQUEST_DECLARATIONS,
  'SDK operations and handbook have one generated contract',
);
let current = true,
  writes = 0;
const form = new SettingsFormStore(
  () => current,
  (value: any) => (Number.isFinite(value.depth) ? {} : { depth: 'invalid' }),
);
form.receive({ text: 'Original', depth: 2 });
form.set('text', 'Local draft');
assert.equal(writes, 0);
form.receive({ text: 'Remote edit', depth: 2 });
assert.equal(form.getSnapshot().draft.text, 'Local draft');
assert.equal(form.getSnapshot().conflict, true);
assert.equal(
  (
    await form.save(async (value: any) => {
      writes++;
      return value;
    })
  ).error,
  'settings_conflict',
);
assert.equal(writes, 0);
form.replace({ text: 'Merged', depth: 2 });
form.rebase();
assert.equal(form.getSnapshot().dirty, true);
assert.equal(
  (
    await form.save(async (value: any) => {
      writes++;
      return { ...value, text: value.text.trim() };
    })
  ).ok,
  true,
);
assert.equal(form.getSnapshot().dirty, false);
await form.save(async (value: any) => {
  writes++;
  return value;
});
assert.equal(writes, 1, 'an unchanged save is not a second write');
form.set('depth', NaN);
assert.ok(Number.isNaN(form.getSnapshot().draft.depth));
assert.equal((await form.save(async (value: any) => value)).error, 'settings_invalid');
form.discard();
form.set('text', 'Confirmed elsewhere');
form.receive({ depth: 2, text: 'Confirmed elsewhere' });
assert.equal(
  form.getSnapshot().dirty,
  false,
  'matching saved data and different object key order do not create false conflicts',
);
form.set('text', 'Retain after failure');
await form.save(async () => {
  throw new Error('provider_failure');
});
assert.equal(form.getSnapshot().draft.text, 'Retain after failure');
form.discard();
form.set('text', 'Late write');
let release!: (value: any) => void;
const saving = form.save(
  () =>
    new Promise((resolve) => {
      release = resolve;
    }),
);
form.dispose();
current = false;
release({ text: 'Late write', depth: 2 });
assert.equal((await saving).error, 'settings_scope_changed');
current = true;
const task = new SettingsTask(() => current);
let reads = 0,
  finish!: (value: any) => void;
const first = task.load(() => {
  reads++;
  return new Promise((resolve) => {
    finish = resolve;
  });
});
const second = task.load(async () => {
  reads++;
  return 99;
});
assert.equal(reads, 1);
finish(42);
assert.equal((await first).value, 42);
assert.equal((await second).value, 42);
await task.load(async () => {
  reads++;
  return 43;
});
assert.equal(reads, 1);
await task.load(async () => {
  reads++;
  return 43;
}, true);
assert.equal(reads, 2);
assert.equal(
  (
    await task.run('failure', async () => {
      throw new Error('quota_exceeded');
    })
  ).error,
  'quota_exceeded',
);
assert.equal(task.getSnapshot().error, 'quota_exceeded');

const values: any = { app: { value: 'a' }, voice: { value: 'b' }, intuition: {} };
const sections = Object.fromEntries(
  Object.keys(values).map((id) => [
    id,
    {
      read: async () => ({ ...values[id] }),
      groups: () => [],
      links: () => [],
      fields: (draft: any, saved: any) =>
        id === 'intuition'
          ? []
          : [
              {
                id: 'value',
                groupId: '',
                type: 'text',
                label: 'Value',
                value: draft.value,
                savedValue: saved.value,
                dirty: draft.value !== saved.value,
                error: null,
                visible: true,
              },
            ],
      write: async (key: string, value: any) => {
        values[id][key] = value;
        return value;
      },
      requests: () => settingsOperations(id, (key: string) => key),
      request: async () => ({ result: { ok: true } }),
    },
  ]),
);
const controller = new ThemeSettingsController({
  catalog: {
    groups: [],
    sections: Object.keys(values).map((id) => ({ id, label: id, groupId: '', mode: 'fields' })),
  },
  sections,
  search: () => [],
  error: (code: string) => code,
});
const action = (sectionId: string, action: string, extra: any = {}) =>
  controller.handle({
    type: 'settingsAction',
    sectionId,
    action,
    editorId: controller.getState().editors[sectionId]?.id,
    ...extra,
  });
await action('app', 'open');
const appId = controller.getState().editor.id;
await action('app', 'edit', { fieldId: 'value', value: 'Unsaved app' });
await action('app', 'openSession');
await action('voice', 'openSession');
assert.equal(controller.getState().editor.id, appId, 'SDK sessions never steal legacy navigation');
assert.equal(controller.getState().editors.app.fields[0].value, 'Unsaved app');
assert.equal(
  await action('voice', 'open'),
  false,
  'legacy navigation keeps the existing dirty guard',
);
await action('voice', 'edit', { fieldId: 'value', value: 'Saved voice' });
await action('voice', 'save');
assert.equal(values.voice.value, 'Saved voice');
assert.equal(controller.getState().editors.app.dirty, true);
await action('app', 'discard');
await action('voice', 'open');
assert.equal(
  controller.getState().editors.app.id,
  appId,
  'adopted legacy draft and SDK draft are the same session',
);
await action('intuition', 'openSession');
const input = {
  method: 'settings',
  requestId: 'fixture',
  sectionId: 'intuition',
  editorId: controller.getState().editors.intuition.id,
  operation: 'getIntuitionConfig',
  params: {},
};
assert.equal(canRequestSettings(controller.getState(), input), true);
assert.equal(canRequestSettings(controller.getState(), { ...input, editorId: appId }), false);
assert.equal((await controller.request(input)).ok, true);
controller.completeRequest(input.requestId);
const scope = controller.getState().scopeId;
controller.dispose();
controller.activate();
assert.notEqual(controller.getState().scopeId, scope);
assert.deepEqual(controller.getState().editors, {});
await assert.rejects(controller.request(input), /settings_request_unavailable/);
const canceled = new SettingsTask(() => true);
let attempts = 0;
const canceledRead = async () => {
  attempts++;
  throw new Error('settings_request_canceled');
};
await canceled.load(canceledRead);
await canceled.retry(canceledRead);
await canceled.retry(canceledRead);
assert.equal(attempts, 2, 'automatic cancellation recovery is bounded, never a polling/retry loop');
console.log(
  'PASS: shared SDK drafts, no implicit writes, canonical conflict/rebase/discard, unchanged-save deduplication, invalid-number preservation, async dedup/stale results and independent host sessions with legacy compatibility',
);
