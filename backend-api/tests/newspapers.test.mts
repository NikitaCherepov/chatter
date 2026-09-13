import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-newspapers-'));
process.env.API_DB_PATH = path.join(tempDir, 'newspapers.db');

const { db } = await import('../src/db.js');
const {
  createDemoNewspaperIssue,
  createNewspaper,
  deleteNewspaperIssue,
  getNewspaperIssue,
  listNewspaperIssues,
  listNewspapers,
  updateNewspaper,
} = await import('../src/services/newspapers.js');

db.prepare(`
  INSERT INTO users (id, name, role, is_admin, status, plan, language)
  VALUES (?, ?, 'user', 0, 'approved', 'free', ?)
`).run(101, 'Тестовый читатель', 'ru');
db.prepare(`
  INSERT INTO users (id, name, role, is_admin, status, plan, language)
  VALUES (?, ?, 'user', 0, 'approved', 'free', ?)
`).run(202, 'Other reader', 'en');

const created = createNewspaper(101, {
  name: 'Утренний ритуал',
  editorial_brief: 'Только действительно важное.',
  interests: 'AI, React, космос',
  preferences: 'Без крипты',
  style: 'magical',
});
assert.equal(created.ok, true);

let newspapers = listNewspapers(101);
assert.equal(newspapers.length, 1);
assert.equal(newspapers[0].name, 'Утренний ритуал');
assert.equal(newspapers[0].style, 'magical');
assert.equal(newspapers[0].issue_count, 0);

const updated = updateNewspaper(101, created.id, { name: 'Chatter Daily', enabled: false });
assert.equal(updated.ok, true);
newspapers = listNewspapers(101);
assert.equal(newspapers[0].name, 'Chatter Daily');
assert.equal(newspapers[0].enabled, false);

const issue = createDemoNewspaperIssue(101);
assert.equal(issue.newspaper_id, created.id);
assert.equal(issue.issue_number, 2);
assert.equal(issue.document.version, 1);
assert.equal(issue.document.blocks.length, 6);
assert.doesNotMatch(JSON.stringify(issue.document), /Тестовый читатель/);
const weather = issue.document.blocks.find((block) => block.type === 'weather');
assert.equal(weather?.type === 'weather' ? weather.periods.length : 0, 3);

assert.equal(listNewspaperIssues(101, created.id).length, 2);
assert.equal(listNewspapers(101)[0].issue_count, 2);
assert.equal(getNewspaperIssue(202, issue.id), null, 'another user must not read the issue');
assert.equal(deleteNewspaperIssue(202, issue.id), false, 'another user must not delete the issue');
assert.equal(deleteNewspaperIssue(101, issue.id), true);
assert.equal(getNewspaperIssue(101, issue.id), null);

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('newspapers storage and ownership: ok');
