import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractQuestionnaires, parseQuestionnaire, questionnaireSchema, validateQuestionnaireAnswers, questionnaireAnswerText } = require('../src/services/message-questionnaires.ts');
const { stripMessageAccents } = require('../src/services/message-accents.ts');

const form = parseQuestionnaire({ id: 'prefs', title: 'Preferences', questions: [
  { id: 'choice', type: 'single', label: 'Which?', required: true, options: ['A', 'B'] },
  { id: 'many', type: 'multiple', label: 'Topics', options: ['One', 'Two'] },
  { id: 'name', type: 'text', label: 'Name' },
  { id: 'notes', type: 'textarea', label: '<script>alert(1)</script>' },
] });
const source = '```questionnaire\n' + JSON.stringify(form) + '\n```';
assert.deepEqual(extractQuestionnaires(source), [form]);
assert.deepEqual(extractQuestionnaires(source.slice(0, -3)), []);
assert.deepEqual(extractQuestionnaires('````md\n' + source + '\n````'), []);
assert.deepEqual(extractQuestionnaires(source + '\n' + source), []);
assert.deepEqual(extractQuestionnaires(Array.from({ length: 5 }, (_, i) => source.replace('"prefs"', `"f${i}"`)).join('\n')), []);
assert.deepEqual(extractQuestionnaires(source.replaceAll('```', '~~~')), [form]);
assert.throws(() => parseQuestionnaire({ ...form, questions: [...form.questions, form.questions[0]] }));
assert.throws(() => parseQuestionnaire({ ...form, questions: Array(101).fill(form.questions[0]) }));
assert.throws(() => validateQuestionnaireAnswers(form, {}));
assert.throws(() => validateQuestionnaireAnswers(form, { choice: 'injected option' }));
assert.throws(() => validateQuestionnaireAnswers(form, { choice: 'A', many: ['One', 'One'] }));
assert.throws(() => validateQuestionnaireAnswers(form, { choice: 'A', other: 'hidden' }));
assert.throws(() => validateQuestionnaireAnswers(form, { choice: 'A', name: 'x'.repeat(1001) }));
const answers = validateQuestionnaireAnswers(form, { choice: 'A', many: ['Two', 'One'], name: ' Me ', notes: 'line 1\nline 2' });
assert.equal(answers.name, 'Me');
assert.deepEqual(answers.many, ['One', 'Two']);
assert.match(stripMessageAccents(source), /1\. Which\? \*\n- A\n- B/);
assert.ok(!stripMessageAccents(source).includes('questionnaire'));
assert.equal(stripMessageAccents('````md\n' + source + '\n````'), '````md\n' + source + '\n````');

const dbPath = path.join(os.tmpdir(), `chatter-questionnaire-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { appendChatMessage, createUserChat, getChatMessages, activateChatMessageVariant, editUserMessage, forkChat, resolveQuestionnaireSubmission } = await import('../src/services/chats.js');
try {
  db.prepare("INSERT INTO users (id, name, language, status) VALUES (81, 'Owner', 'en', 'approved'), (82, 'Stranger', 'en', 'approved')").run();
  const chat = createUserChat(81, 'Forms');
  const assistant = await appendChatMessage(81, chat, 'assistant', source);
  const submission = { source_message_id: assistant, source_variant_index: 0, form_id: form.id, schema: questionnaireSchema(form), answers };
  assert.equal(resolveQuestionnaireSubmission(81, chat, submission).questionnaire.title, 'Preferences');
  assert.throws(() => resolveQuestionnaireSubmission(82, chat, submission), /questionnaire_not_found/);
  assert.throws(() => resolveQuestionnaireSubmission(81, chat, { ...submission, schema: '{}' }), /questionnaire_stale/);
  await appendChatMessage(81, chat, 'assistant', source.replace('Preferences', 'New preferences'), null, null, null, null, null, null, null, { regenerateMessageId: assistant });
  const save = () => appendChatMessage(81, chat, 'user', questionnaireAnswerText(form, answers), null, null, null, null, null, null, null, { questionnaireSubmission: submission });
  await assert.rejects(save, /questionnaire_stale/, 'must revalidate at the actual insert, not just request acceptance');
  assert.equal(getChatMessages(81, chat).length, 1, 'stale submissions leave no user row');
  activateChatMessageVariant(81, chat, assistant, 0);
  const [one, two] = await Promise.allSettled([save(), save()]);
  assert.equal(one.status, 'fulfilled'); assert.equal(two.status, 'rejected');
  if (one.status !== 'fulfilled') throw one.reason;
  const result = getChatMessages(81, chat).find(m => m.id === one.value)!;
  assert.deepEqual(result.questionnaire_response?.questionnaire, form);
  assert.deepEqual(result.questionnaire_response?.answers, { ...answers });
  assert.equal(editUserMessage(81, chat, one.value, 'tamper').ok, false);
  editUserMessage(81, chat, assistant, source.replace('Preferences', 'Edited later'));
  assert.equal(getChatMessages(81, chat).find(m => m.id === one.value)?.questionnaire_response?.questionnaire.title, 'Preferences', 'immutable snapshot survives original edit');
  const fork = forkChat(81, chat, one.value);
  const branch = getChatMessages(81, fork.chat_id);
  const branchedAssistant = branch.find(m => m.role === 'assistant')!;
  assert.equal(branch.find(m => m.role === 'user')?.questionnaire_response?.source_message_id, branchedAssistant.id, 'source reference remapped on fork');
  assert.equal(branch.find(m => m.role === 'user')?.questionnaire_response?.questionnaire.title, 'Preferences');
  console.log('questionnaire schema, validation, stale/duplicate submission, snapshot and fork tests passed');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
}
