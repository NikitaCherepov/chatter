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
const imageForm = parseQuestionnaire({ ...form, questions: form.questions.map(q => ({ ...q, image: { url: '/uploads/question.png', alt: 'Question illustration' } })) });
assert.equal(imageForm.questions[0].image?.url, '/uploads/question.png');
assert.equal(parseQuestionnaire({ ...form, questions: [{ ...form.questions[0], image: { url: 'https://example.org/picture' } }] }).questions[0].image?.alt, form.questions[0].label);
for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'file:///secret', '//evil.org/x', '/\\evil.org/x', 'https://example.org/a\nb', 'https://example.org/' + 'x'.repeat(2048)]) {
  assert.throws(() => parseQuestionnaire({ ...form, questions: [{ ...form.questions[0], image: { url } }] }), /questionnaire_invalid/);
}
assert.notEqual(questionnaireSchema(imageForm), questionnaireSchema(form), 'image belongs to exact form revision');
assert.match(questionnaireAnswerText(imageForm, { choice: 'A' }), /Image: \/uploads\/question.png \(Question illustration\)/);
assert.match(stripMessageAccents('```questionnaire\n' + JSON.stringify(imageForm) + '\n```'), /Image: \/uploads\/question.png/);
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
let otherForm = parseQuestionnaire({ ...form, questions: form.questions.map(q => q.type === 'single' || q.type === 'multiple' ? { ...q, allowOther: true } : q) });
assert.deepEqual(validateQuestionnaireAnswers(otherForm, { choice: 'A' }).choice, 'A', 'Other is optional');
assert.deepEqual(validateQuestionnaireAnswers(otherForm, { choice: { other: ' Custom ' }, many: { selected: ['Two'], other: 'Third' } }).choice, { other: 'Custom' });
assert.deepEqual(validateQuestionnaireAnswers(otherForm, { choice: 'A', many: { selected: ['Two', 'One'], other: 'Third' } }).many, { other: 'Third', selected: ['One', 'Two'] });
assert.throws(() => validateQuestionnaireAnswers(otherForm, { choice: { other: ' ' } }), /questionnaire_invalid/);
assert.throws(() => validateQuestionnaireAnswers(form, { choice: { other: 'Not allowed' } }), /questionnaire_invalid/);
assert.throws(() => validateQuestionnaireAnswers(otherForm, { choice: { other: 'x'.repeat(1001) } }), /questionnaire_invalid/);
assert.throws(() => validateQuestionnaireAnswers(otherForm, { choice: { other: 'Custom', selected: ['A'] } }), /questionnaire_invalid/);
assert.throws(() => validateQuestionnaireAnswers(otherForm, { choice: 'A', many: { selected: ['unknown'], other: 'Custom' } }), /questionnaire_invalid/);
assert.match(questionnaireAnswerText(otherForm, validateQuestionnaireAnswers(otherForm, { choice: { other: 'Custom' } })), /Custom/);
assert.match(stripMessageAccents('```questionnaire\n' + JSON.stringify(otherForm) + '\n```'), /Other \(free text\)/);
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
  const otherChat = createUserChat(81, 'Other answers');
  otherForm = parseQuestionnaire({ ...otherForm, questions: otherForm.questions.map((q, index) => index === 0 ? { ...q, image: imageForm.questions[0].image } : q) });
  const otherSource = await appendChatMessage(81, otherChat, 'assistant', '```questionnaire\n' + JSON.stringify(otherForm) + '\n```');
  const otherAnswers = validateQuestionnaireAnswers(otherForm, { choice: { other: 'Custom format' }, many: { selected: ['Two'], other: 'Third topic' } });
  const otherSubmission = { source_message_id: otherSource, source_variant_index: 0, form_id: otherForm.id, schema: questionnaireSchema(otherForm), answers: otherAnswers };
  const otherMessage = await appendChatMessage(81, otherChat, 'user', questionnaireAnswerText(otherForm, otherAnswers), null, null, null, null, null, null, null, { questionnaireSubmission: otherSubmission });
  assert.deepEqual(getChatMessages(81, otherChat).find(m => m.id === otherMessage)?.questionnaire_response?.answers, { ...otherAnswers }, 'custom answers survive persistence as structured data');
  assert.deepEqual(getChatMessages(81, otherChat).find(m => m.id === otherMessage)?.questionnaire_response?.questionnaire.questions[0].image, imageForm.questions[0].image, 'question image stays in the immutable response snapshot');
  console.log('questionnaire schema, validation, stale/duplicate submission, snapshot and fork tests passed');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
}
