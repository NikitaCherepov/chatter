import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-stream-test-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(directory, 'uploads');
const { db } = await import('../src/db.js');
const { extractBackupStream, assertBackupSpace } = await import('../src/services/sillytavern-archive-stream.js');
const { classifyBackupPath, previewSillyTavernBackup, importSillyTavernBackup } = await import('../src/services/sillytavern-backup-import.js');
const { uploadBackupSession, cancelBackupSession, backupSessionStatus, startBackupSession } = await import('../src/services/sillytavern-backup-session.js');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
const otherPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0000ff' } }).png().toBuffer();
const rows = [
  { user_name: 'Test User', character_name: 'Test Character' },
  { name: 'Test User', is_user: true, mes: '', extra: { files: [{ url: '/files/notes.txt', name: 'Notes.txt' }] } },
  { name: 'Test Character', is_user: false, mes: 'New reply', swipes: ['Old reply', 'New reply'], swipe_id: 1,
    extra: { media: [{ url: '/images/Test/new.png', type: 'image' }, { url: '/images/Test/missing.png', type: 'image' }] },
    swipe_info: [{ extra: { image: '/images/Test/old.png' } }, { extra: { image: '/images/Test/new.png' } }] },
  { name: 'Test User', is_user: true, mes: 'A repeated image', extra: { image: '/images/Test/new.png' } },
];
const contents = {
  'data/default-user/chats/Test/thread.jsonl': strToU8(rows.map(row => JSON.stringify(row)).join('\n')),
  'data/default-user/images/Test/new.png': png,
  'data/default-user/images/Test/old.png': otherPng,
  'data/default-user/files/notes.txt': strToU8('The spare key is in the green box.'),
  'data/default-user/worlds/ignored.json': strToU8('{}'),
};
const zip = Buffer.from(zipSync(contents));
const chunks = [];
for (let i = 0; i < zip.length; i += 97) chunks.push(zip.subarray(i, i + 97));
const extractedDir = path.join(directory, 'extracted');
fs.mkdirSync(extractedDir);
const entries = await extractBackupStream(Readable.from(chunks), extractedDir, name => ['character', 'chat', 'settings', 'persona_avatar', 'media'].includes(classifyBackupPath(name)));
assert.ok(Object.getOwnPropertyDescriptor(entries.find(entry => entry.name.endsWith('thread.jsonl'))!, 'data')?.get, 'entries read from disk lazily');
assert.equal(fs.readdirSync(extractedDir).length, 4, 'ignored lorebook was not written to disk');
assert.throws(() => assertBackupSpace(extractedDir, Number.MAX_SAFE_INTEGER), /insufficient_space/);
db.prepare("INSERT INTO users (id, name, language) VALUES (100, 'Tester', 'en')").run();
const preview = previewSillyTavernBackup(100, entries);
assert.equal(preview.chats.message_count, 3, 'media-only messages survive');
assert.equal(preview.media.images, 2);
assert.equal(preview.media.files, 1);
assert.equal(preview.media.missing, 1);
const imported = await importSillyTavernBackup(100, entries);
assert.deepEqual(imported.media, { images: 3, files: 1, missing: 1, errors: 0 });
const messages = db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY timeline_index').all(imported.chats.chat_ids[0]) as any[];
const file = JSON.parse(messages[0].attachments)[0];
assert.equal(file.extracted_text, 'The spare key is in the green box.');
assert.equal(file.name, 'Notes.txt');
assert.ok(fs.existsSync(path.join(process.env.UPLOADS_DIR, file.filename)));
const variants = db.prepare('SELECT variant_index, images FROM chat_message_variants WHERE message_id = ? ORDER BY variant_index').all(messages[1].id) as any[];
assert.notEqual(JSON.parse(variants[0].images)[0].url, JSON.parse(variants[1].images)[0].url, 'inactive and active swipe keep different images');
assert.equal(JSON.parse(messages[1].images)[0].url, JSON.parse(variants[1].images)[0].url);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n, 2, 'identical image bytes reuse an asset');
const filesBefore = fs.readdirSync(process.env.UPLOADS_DIR).length;
db.prepare('UPDATE chat_messages SET active_variant_index = 0, images = ? WHERE id = ?').run(variants[0].images, messages[1].id);
const again = await importSillyTavernBackup(100, entries);
assert.equal(again.chats.existing, 1);
assert.equal(again.media.images, 0);
assert.equal(again.media.files, 0);
assert.equal(fs.readdirSync(process.env.UPLOADS_DIR).length, filesBefore, 'reimport allocates no duplicate files');
assert.equal(JSON.parse(db.prepare('SELECT images FROM chat_message_variants WHERE message_id = ? AND variant_index = 0').get(messages[1].id).images).length, 1, 'reimport after switching variants does not mix attachments');

// Missing attachments can be recovered on a later import of the same chat.
const fixedDir = path.join(directory, 'fixed');
fs.mkdirSync(fixedDir);
const fixedEntries = await extractBackupStream(Readable.from([Buffer.from(zipSync({ ...contents, 'data/default-user/images/Test/missing.png': otherPng }))]), fixedDir, () => true);
const recovered = await importSillyTavernBackup(100, fixedEntries);
assert.equal(recovered.media.images, 1);
assert.equal(recovered.media.missing, 0);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_chats').get().n, 1);

const upload = await uploadBackupSession(100, Readable.from([zip]), zip.length);
assert.ok(upload.preview.storage.sufficient);
assert.ok(upload.preview.storage.required_bytes > 0);
assert.throws(() => backupSessionStatus(101, upload.import_id), /session_expired/, 'another user cannot inspect a session');
const sessionRoot = path.join(process.env.UPLOADS_DIR, '.sillytavern-imports');
assert.ok(fs.existsSync(path.join(sessionRoot, upload.import_id)));
cancelBackupSession(100, upload.import_id);
assert.ok(!fs.existsSync(path.join(sessionRoot, upload.import_id)));
assert.throws(() => backupSessionStatus(100, upload.import_id), /session_expired/);

const running = await uploadBackupSession(100, Readable.from([zip]), zip.length);
startBackupSession(100, running.import_id);
assert.throws(() => startBackupSession(100, running.import_id), /not_ready/, 'cannot start twice');
let status = backupSessionStatus(100, running.import_id);
for (let tries = 0; status.status === 'running' && tries < 100; tries++) {
  await new Promise(resolve => setTimeout(resolve, 10));
  status = backupSessionStatus(100, running.import_id);
}
assert.equal(status.status, 'complete');
assert.equal(status.result?.chats.existing, 1);
await new Promise(resolve => setImmediate(resolve));
assert.ok(!fs.existsSync(path.join(sessionRoot, running.import_id)), 'completed job removes staging data');
cancelBackupSession(100, running.import_id);

const cancelled = await uploadBackupSession(100, Readable.from([zip]), zip.length);
startBackupSession(100, cancelled.import_id);
cancelBackupSession(100, cancelled.import_id);
let cancelledStatus = backupSessionStatus(100, cancelled.import_id);
for (let tries = 0; cancelledStatus.status === 'running' && tries < 100; tries++) {
  await new Promise(resolve => setTimeout(resolve, 10));
  cancelledStatus = backupSessionStatus(100, cancelled.import_id);
}
assert.equal(cancelledStatus.status, 'cancelled');
await new Promise(resolve => setImmediate(resolve));
assert.ok(!fs.existsSync(path.join(sessionRoot, cancelled.import_id)));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_chats').get().n, 1, 'cancellation keeps existing chats');
cancelBackupSession(100, cancelled.import_id);

const spaceCheck = await uploadBackupSession(100, Readable.from([zip]), zip.length);
const statfsOriginal = fs.statfsSync;
try {
  fs.statfsSync = ((...args: any[]) => ({ ...statfsOriginal(args[0]), bavail: 0 })) as typeof fs.statfsSync;
  assert.throws(() => startBackupSession(100, spaceCheck.import_id), /insufficient_space/, 'free space is rechecked at confirmation');
} finally { fs.statfsSync = statfsOriginal; }
cancelBackupSession(100, spaceCheck.import_id);

await assert.rejects(() => uploadBackupSession(100, Readable.from([Buffer.from('not a zip')])), /invalid_zip/);
await assert.rejects(() => uploadBackupSession(100, Readable.from([zip.subarray(0, 60)])), /invalid_zip/);
await assert.rejects(() => uploadBackupSession(100, Readable.from([zip.subarray(0, zip.length - 22)])), /invalid_zip/, 'reject missing central directory footer');
await assert.rejects(() => uploadBackupSession(100, Readable.from([Buffer.from(zipSync({ '../escape.txt': strToU8('bad') }))])), /invalid_path/);
await assert.rejects(() => uploadBackupSession(100, Readable.from([Buffer.from(zipSync({ 'images/A.png': png, 'images/a.png': png }))])), /duplicate_path/);
await assert.rejects(() => uploadBackupSession(100, Readable.from([Buffer.from(zipSync({ 'files/bomb.txt': new Uint8Array(33 * 1024 * 1024) }))])), /too_large/);
const aborted = new Readable({ read() { this.destroy(new Error('aborted')); } });
await assert.rejects(() => uploadBackupSession(100, aborted), /invalid_zip/);
assert.deepEqual(fs.readdirSync(sessionRoot), [], 'every failed upload cleans up staging');
db.close();
fs.rmSync(directory, { recursive: true, force: true });
console.log('SillyTavern streamed backup and media tests passed');
