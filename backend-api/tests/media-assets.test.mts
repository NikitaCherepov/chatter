import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-media-assets-'));
const dbPath = path.join(tempDir, 'media.db');
const uploadsDir = path.join(tempDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
process.env.API_DB_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;

const legacyFilename = 'legacy-image.png';
const legacyPath = path.join(uploadsDir, legacyFilename);
await sharp({
  create: {
    width: 2,
    height: 2,
    channels: 4,
    background: { r: 10, g: 20, b: 30, alpha: 1 },
  },
}).png().toFile(legacyPath);

const { db } = await import('../src/db.js');
const { runMigrations } = await import('../src/services/migrations.js');

db.prepare("INSERT INTO users (id, name, status, plan) VALUES (1, 'Owner', 'approved', 'free')").run();
db.prepare("INSERT INTO users (id, name, status, plan) VALUES (2, 'Member', 'approved', 'free')").run();
db.prepare("INSERT INTO users (id, name, status, plan) VALUES (3, 'Stranger', 'approved', 'free')").run();
const chatId = Number(db.prepare("INSERT INTO user_chats (user_id, title, room_enabled) VALUES (1, 'Room', 1)").run().lastInsertRowid);
const legacyUrl = `/api/v1/images/${legacyFilename}`;
const legacyMessageId = Number(db.prepare(`
  INSERT INTO chat_messages (user_id, role, content, chat_id, images)
  VALUES (1, 'user', 'legacy', ?, ?)
`).run(chatId, JSON.stringify([{ url: legacyUrl, type: 'user_photo' }])).lastInsertRowid);

const migrationResult = runMigrations();
assert.ok(migrationResult.applied.includes('0007_backfill_media_assets'));

const legacyAsset = db.prepare('SELECT * FROM media_assets WHERE storage_filename = ?')
  .get(legacyFilename) as any;
assert.ok(legacyAsset, 'backfill must register an existing image file');
assert.equal(legacyAsset.user_id, 1);
assert.equal(legacyAsset.retention, 'persistent');
assert.ok(db.prepare(`
  SELECT 1 FROM media_asset_references
  WHERE asset_id = ? AND entity_type = 'chat_message' AND entity_id = ?
`).get(legacyAsset.id, legacyMessageId), 'backfill must reference the original message');

const {
  getMediaAssetByFilename,
  saveImageAsset,
} = await import('../src/services/media-assets.js');
const { canUserReadRegisteredImage } = await import('../src/services/media-access.js');
const { appendChatMessage, deleteUserMessage } = await import('../src/services/chats.js');
const { attachFileToResponse } = await import('../src/services/response-attachments.js');
const { resolveEmailAttachmentsForUser } = await import('../src/services/mail.js');

assert.equal(canUserReadRegisteredImage(1, legacyFilename), true, 'owner reads own asset');
assert.equal(canUserReadRegisteredImage(2, legacyFilename), false, 'unrelated user must not read asset');
assert.equal(canUserReadRegisteredImage(3, legacyFilename), false, 'another unrelated user must not read asset');

db.prepare(`
  INSERT INTO chat_members (chat_id, user_id, role)
  VALUES (?, 2, 'member')
`).run(chatId);
assert.equal(canUserReadRegisteredImage(2, legacyFilename), true, 'room member reads referenced room asset');
assert.equal(canUserReadRegisteredImage(3, legacyFilename), false, 'room access must not become public');

const generatedBuffer = await sharp({
  create: {
    width: 3,
    height: 3,
    channels: 4,
    background: { r: 90, g: 80, b: 70, alpha: 1 },
  },
}).png().toBuffer();
const generated = await saveImageAsset({
  userId: 1,
  data: generatedBuffer,
  retention: 'temporary',
  kind: 'generated',
});
assert.equal(generated.retention, 'temporary');
assert.ok(generated.expires_at);
assert.equal(canUserReadRegisteredImage(1, generated.storage_filename), true);
assert.equal(canUserReadRegisteredImage(2, generated.storage_filename), false, 'temporary asset stays private');

const responseSink = {
  images: [],
  attachments: [],
  sourceKeys: new Set<string>(),
};
const attachResult = JSON.parse(await attachFileToResponse(
  1,
  { url: generated.url },
  responseSink,
));
assert.equal(attachResult.status, 'attached');
assert.deepEqual(responseSink.images, [{ url: generated.url, type: 'external' }]);
assert.equal(
  JSON.parse(await attachFileToResponse(1, { url: generated.url }, responseSink)).status,
  'already_attached',
);
await assert.rejects(
  () => attachFileToResponse(3, { url: generated.url }, {
    images: [],
    attachments: [],
    sourceKeys: new Set<string>(),
  }),
  /media_asset_not_found_or_not_owned/,
  'another user cannot attach the asset',
);

const emailAttachments = await resolveEmailAttachmentsForUser(1, [generated.url]);
assert.equal(emailAttachments.length, 1);
assert.equal(emailAttachments[0].filepath, path.join(uploadsDir, generated.storage_filename));
assert.equal(emailAttachments[0].mimeType, generated.mime_type);
await assert.rejects(
  () => resolveEmailAttachmentsForUser(3, [generated.url]),
  /email_attachment_not_owned/,
  'another user cannot use the image as an email attachment',
);

const image = { url: generated.url, type: 'generated' as const };
const firstMessageId = await appendChatMessage(1, chatId, 'assistant', 'first', null, null, [image]);
const secondMessageId = await appendChatMessage(1, chatId, 'assistant', 'second', null, null, [image]);
const attached = getMediaAssetByFilename(generated.storage_filename)!;
assert.equal(attached.retention, 'persistent', 'attachment promotes temporary asset');
assert.equal(attached.expires_at, null);
assert.equal(canUserReadRegisteredImage(2, generated.storage_filename), true, 'room member reads attached asset');
assert.equal(canUserReadRegisteredImage(3, generated.storage_filename), false, 'attachment does not make asset public');

assert.equal(deleteUserMessage(1, chatId, firstMessageId), true);
assert.ok(fs.existsSync(path.join(uploadsDir, generated.storage_filename)), 'one remaining reference keeps the file');
assert.ok(getMediaAssetByFilename(generated.storage_filename), 'one remaining reference keeps the asset row');

assert.equal(deleteUserMessage(1, chatId, secondMessageId), true);
assert.equal(fs.existsSync(path.join(uploadsDir, generated.storage_filename)), false, 'last reference removal deletes the file');
assert.equal(getMediaAssetByFilename(generated.storage_filename), null, 'last reference removal deletes the asset row');

assert.deepEqual(runMigrations().applied, [], 'media migrations are idempotent');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('media assets: ok');
