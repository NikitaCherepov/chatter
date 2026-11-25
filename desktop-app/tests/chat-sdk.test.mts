import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  ComposerStore,
  ConfirmationFieldsStore,
  chatStore,
  chatCurrent,
  updateChatState,
  conversationTimeline,
  previewTask,
} = require('../src/interactive/chat-store.ts');
const { scheduleSdkRead } = require('../src/interactive/settings-sdk.ts');
const base: any = {
  scopeId: 'account-a',
  activeChatId: 1,
  canSend: true,
  sending: false,
  attachmentCount: 0,
  composer: { busy: false },
  messages: [],
  context: { showTokens: false, summary: null },
};
updateChatState(base);
const first = chatStore('composer:1', () => new ComposerStore(() => chatCurrent('account-a', 1)));
assert.equal(
  chatStore('composer:1', () => {
    throw Error('must share');
  }),
  first,
);
assert.equal(first.setText('Draft'), true);
assert.equal(
  first.send(base, () => false),
  false,
);
assert.equal(first.getSnapshot().text, 'Draft');
let sent: string[] = [];
assert.equal(
  first.send(base, (text: string) => {
    sent.push(text);
    return true;
  }),
  true,
);
assert.deepEqual(sent, ['Draft']);
assert.equal(first.getSnapshot().text, '');
assert.equal(
  first.send(
    base,
    () => {
      throw Error('duplicate');
    },
    'second',
  ),
  false,
);
const filesOnly = { ...base, attachmentCount: 1 };
updateChatState(filesOnly);
assert.equal(
  first.send(filesOnly, () => true),
  true,
  'attachments can be sent without text',
);
first.setText('existing');
first.appendTranscript({ id: 1, text: 'voice' });
first.appendTranscript({ id: 1, text: 'voice' });
assert.equal(
  first.getSnapshot().text,
  'existing voice',
  'shared consumers consume a transcript once',
);
assert.equal(first.setText('x'.repeat(100001)), false);
updateChatState({ ...base, activeChatId: 2 });
assert.equal(first.setText('wrong chat'), false);
const second = chatStore('composer:2', () => new ComposerStore(() => chatCurrent('account-a', 2)));
assert.equal(second.getSnapshot().text, '');
updateChatState(base);
assert.equal(first.getSnapshot().text, 'existing voice', 'chat drafts survive navigation/unmount');
first.appendTranscript({ id: 1, text: 'voice' });
assert.equal(first.getSnapshot().text, 'existing voice');

const summary = { kind: 'summary', throughTimelineIndex: 10, title: 'Recap', content: 'Context' };
const messages = [
  { id: 1, variantIndex: 0, timelineIndex: 4, archived: true },
  { id: 2, variantIndex: 0, timelineIndex: 11 },
];
assert.deepEqual(
  conversationTimeline({ messages, context: { showTokens: false, summary } }).map(
    (item: any) => item.kind,
  ),
  ['message', 'summary', 'message'],
);
assert.equal(
  conversationTimeline({ messages: messages.slice(0, 1), context: { summary } }).at(-1).kind,
  'summary',
);
assert.equal(
  conversationTimeline({ messages: [], context: { summary } })[0].summary,
  summary,
  'a summary is visible even without loaded messages',
);

let calls = 0,
  finish!: (value: any) => void;
const task = previewTask('account-a', 'document:1', () => chatCurrent('account-a', 1));
const load = () => {
  calls++;
  return new Promise((resolve) => {
    finish = resolve;
  });
};
const a = task.load(load),
  b = task.load(load);
assert.equal(a, b);
assert.equal(calls, 1);
finish({ text: 'document' });
assert.equal((await a).ok, true);
assert.equal((await task.load(load)).value.text, 'document');
assert.equal(calls, 1);
const keep = previewTask('account-a', 'subscribed', () => chatCurrent('account-a', 1));
let notices = 0;
const release = keep.subscribe(() => notices++);
for (let n = 0; n < 40; n++)
  previewTask('account-a', 'inactive:' + n, () => chatCurrent('account-a', 1));
assert.equal(
  previewTask('account-a', 'subscribed', () => false),
  keep,
  'cache eviction never disconnects a mounted consumer',
);
await keep.load(async () => ({ text: 'still live' }));
assert.ok(notices);
release();
let finishOld!: (value: any) => void;
const oldTask = previewTask('account-a', 'late', () => chatCurrent('account-a', 1));
const pending = oldTask.load(
  () =>
    new Promise((resolve) => {
      finishOld = resolve;
    }),
);
updateChatState({ ...base, scopeId: 'account-b' });
finishOld({ text: 'private old data' });
assert.equal((await pending).ok, false);
assert.equal(oldTask.getSnapshot().data, undefined);
assert.equal(first.setText('wrong account'), false);
const replacement = chatStore(
  'composer:1',
  () => new ComposerStore(() => chatCurrent('account-b', 1)),
);
assert.notEqual(replacement, first);
assert.equal(replacement.getSnapshot().text, '');
const fields = chatStore('confirmation:one', () => new ConfirmationFieldsStore(() => true));
assert.equal(
  chatStore('confirmation:one', () => {
    throw Error('must share pending fields');
  }),
  fields,
);
assert.equal(
  fields.set('allow', true, () => false),
  false,
);
assert.deepEqual(fields.getSnapshot(), {});
fields.set('allow', true, () => true);
assert.equal(
  Object.keys(fields.getSnapshot()).length,
  1,
  'an accepted field blocks decisions until acknowledgement',
);
fields.sync({ fields: [{ id: 'allow', value: false, disabled: false }] });
assert.equal(fields.getSnapshot().allow, true, 'old snapshots do not clear pending choices');
fields.sync({ fields: [{ id: 'allow', value: true, disabled: false }] });
assert.deepEqual(fields.getSnapshot(), {});
let parallel = 0,
  peak = 0;
const scheduled = Array.from({ length: 8 }, (_, index) =>
  scheduleSdkRead(async () => {
    parallel++;
    peak = Math.max(peak, parallel);
    await new Promise((resolve) => setTimeout(resolve, 2));
    parallel--;
    return index;
  }),
);
assert.deepEqual(await Promise.all(scheduled), [0, 1, 2, 3, 4, 5, 6, 7]);
assert.equal(peak, 3, 'media and settings share the existing bounded read queue');
console.log(
  'PASS: shared per-chat drafts, rejected/duplicate/attachment-only sends, transcript deduplication, navigation retention, recap placement, preview deduplication/cache ownership and stale-account isolation',
);
