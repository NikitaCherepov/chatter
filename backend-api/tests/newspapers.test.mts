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
  createNewspaperRun,
  deleteNewspaperIssue,
  getNewspaperIssue,
  getNewspaperRun,
  listNewspaperIssues,
  listNewspaperRuns,
  listNewspapers,
  updateNewspaper,
  validateNewspaperDocument,
} = await import('../src/services/newspapers.js');
const { attachMediaAsset, getMediaAssetById } = await import('../src/services/media-assets.js');

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
  source_recommendations: 'NASA, Ars Technica',
  issue_volume: 'compact',
  weather_mode: 'today',
  weather_location: 'Томск',
  delivery_frequency: 'manual',
  style: 'wizarding',
});
assert.equal(created.ok, true);

let newspapers = listNewspapers(101);
assert.equal(newspapers.length, 1);
assert.equal(newspapers[0].name, 'Утренний ритуал');
assert.equal(newspapers[0].style, 'wizarding');
assert.equal(newspapers[0].source_recommendations, 'NASA, Ars Technica');
assert.equal(newspapers[0].issue_volume, 'compact');
assert.equal(newspapers[0].weather_mode, 'today');
assert.equal(newspapers[0].weather_location, 'Томск');
assert.equal(newspapers[0].delivery_frequency, 'manual');
assert.equal(newspapers[0].issue_count, 0);

const updated = updateNewspaper(101, created.id, {
  name: 'Chatter Daily',
  enabled: false,
  issue_volume: 'extended',
  weather_mode: 'week',
});
assert.equal(updated.ok, true);
newspapers = listNewspapers(101);
assert.equal(newspapers[0].name, 'Chatter Daily');
assert.equal(newspapers[0].enabled, false);
assert.equal(newspapers[0].issue_volume, 'extended');
assert.equal(newspapers[0].weather_mode, 'week');

const issue = createDemoNewspaperIssue(101);
assert.equal(issue.newspaper_id, created.id);
assert.equal(issue.issue_number, 1);
assert.equal(issue.document.version, 1);
assert.equal(issue.document.blocks.length, 5);
assert.deepEqual(
  new Set(issue.document.blocks.map((block) => block.type)),
  new Set(['article', 'note', 'notes_list', 'weather', 'image']),
);
assert.doesNotMatch(JSON.stringify(issue.document), /Тестовый читатель/);
const weather = issue.document.blocks.find((block) => block.type === 'weather');
assert.equal(weather?.type === 'weather' ? weather.periods.length : 0, 3);

assert.equal(listNewspaperIssues(101, created.id).length, 1);
assert.equal(listNewspapers(101)[0].issue_count, 1);
assert.equal(getNewspaperIssue(202, issue.id), null, 'another user must not read the issue');
assert.equal(deleteNewspaperIssue(202, issue.id), false, 'another user must not delete the issue');

assert.throws(() => validateNewspaperDocument({
  version: 1,
  title: 'Legacy',
  date: '2026-09-16',
  blocks: [{ id: 'legacy', type: 'hero', title: 'Nope', text: 'Nope' }],
}), /invalid_newspaper_block/);

const localImageDocument = validateNewspaperDocument({
  version: 1,
  title: 'Local image',
  date: '2026-09-17',
  blocks: [{
    id: 'local-image',
    type: 'article',
    role: 'hero',
    title: 'Stored safely',
    text: 'The local image URL must survive validation.',
    image_url: '/api/v1/images/newspaper-test.webp',
  }],
});
assert.equal(localImageDocument.blocks[0].type === 'article' ? localImageDocument.blocks[0].image_url : null, '/api/v1/images/newspaper-test.webp');
const unsafeImageDocument = validateNewspaperDocument({
  version: 1,
  title: 'Unsafe image',
  date: '2026-09-17',
  blocks: [{
    id: 'unsafe-image',
    type: 'article',
    role: 'hero',
    title: 'Rejected path',
    text: 'Traversal must not survive validation.',
    image_url: '/api/v1/images/%2e%2e%2fsecret.png',
  }],
});
assert.equal(unsafeImageDocument.blocks[0].type === 'article' ? unsafeImageDocument.blocks[0].image_url : undefined, undefined);

const runResult = createNewspaperRun(101, created.id);
assert.equal(runResult.ok, true);
if (!runResult.ok) throw new Error('run must be created');
assert.equal(runResult.run.status, 'queued');
assert.equal(getNewspaperRun(202, runResult.run.id), null, 'another user must not read the run');
assert.equal(listNewspaperRuns(101, created.id).length, 1);
const duplicateRun = createNewspaperRun(101, created.id);
assert.equal(duplicateRun.ok, false);
assert.equal(duplicateRun.error, 'newspaper_run_active');

const now = Math.floor(Date.now() / 1000);
const mediaId = Number(db.prepare(`
  INSERT INTO media_assets (
    user_id, storage_filename, local_url, mime_type, kind, retention,
    size_bytes, created_at, updated_at
  ) VALUES (101, 'newspaper-test.webp', '/api/v1/images/newspaper-test.webp',
            'image/webp', 'external', 'temporary', 10, ?, ?)
`).run(now, now).lastInsertRowid);
attachMediaAsset({
  assetId: mediaId,
  entityType: 'newspaper_issue',
  entityId: issue.id,
  slot: 'image',
});
assert.equal(getMediaAssetById(mediaId)?.retention, 'persistent');

assert.equal(deleteNewspaperIssue(101, issue.id), true);
assert.equal(getNewspaperIssue(101, issue.id), null);
assert.equal(getMediaAssetById(mediaId), null, 'deleting the last newspaper reference removes its asset');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('newspapers storage and ownership: ok');
