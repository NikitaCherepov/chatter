const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { rotateDatabase, encrypt, decrypt, FIELDS } = require('../scripts/rotate-encryption.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-rekey-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new Database(file);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const tables = new Map();
  for (const [table, column] of FIELDS) tables.set(table, [...(tables.get(table) || []), column]);
  for (const [table, columns] of tables) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, ${columns.map(c => `${c} TEXT`).join(', ')})`);
    db.prepare(`INSERT INTO ${table} (id) VALUES (7)`).run();
  }
  db.exec("CREATE TABLE chats (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO chats VALUES (18, 'untouched chat');");
  return { db, file };
}
test('all encrypted fields survive rotation with stable IDs and ordinary data untouched', t => {
  const { db, file } = fixture(t);
  const plain = Buffer.from('Привет: секрет\nline two');
  for (const [table, column, format] of FIELDS) {
    const value = format === 'gcm' ? Buffer.from(JSON.stringify({ access_token: 'test-only', refresh_token: 'refresh-only', scopes: [] })) : plain;
    db.prepare(`UPDATE ${table} SET ${column} = ?`).run(encrypt(value, 'old', format));
  }
  const before = db.prepare('SELECT key_encrypted FROM api_keys').get().key_encrypted;
  assert.equal(rotateDatabase(file, 'old', 'new').fields, FIELDS.length);
  for (const [table, column, format] of FIELDS) {
    const row = db.prepare(`SELECT id, ${column} AS value FROM ${table}`).get();
    assert.equal(row.id, 7);
    const value = decrypt(row.value, 'new', format);
    if (format === 'gcm') assert.equal(JSON.parse(value).access_token, 'test-only');
    else assert.deepEqual(value, plain);
    if (format === 'gcm') assert.throws(() => decrypt(row.value, 'old', format));
  }
  assert.notEqual(db.prepare('SELECT key_encrypted FROM api_keys').get().key_encrypted, before);
  assert.deepEqual(db.prepare('SELECT * FROM chats').get(), { id: 18, text: 'untouched chat' });
  assert.equal(rotateDatabase(file, 'new', 'new', {}, true).fields, 0);
});
test('corrupt field rolls back the entire transaction, without secret content in errors', t => {
  const { db, file } = fixture(t);
  const first = encrypt(Buffer.from('test-only-secret'), 'old', '::');
  db.prepare('UPDATE api_keys SET key_encrypted = ?').run(first);
  db.prepare('UPDATE mail_accounts SET imap_pass = ?').run('broken-secret');
  assert.throws(() => rotateDatabase(file, 'old', 'new'), /cannot_reencrypt:mail_accounts.imap_pass:row_7/);
  assert.equal(db.prepare('SELECT key_encrypted FROM api_keys').get().key_encrypted, first);
});
test('independent override keys and legacy plaintext remain unchanged; shared fallback is rotated', t => {
  const { db, file } = fixture(t);
  const separate = encrypt(Buffer.from('ssh-secret'), 'devops-only', ':');
  db.prepare('UPDATE devops_servers SET password_enc = ?, private_key_enc = NULL').run(separate);
  const fallback = encrypt(Buffer.from('55.7'), 'old', ':');
  db.prepare('UPDATE map_pins SET lat_enc = ?, lng_enc = ?').run(fallback, '37.6');
  db.prepare('UPDATE smart_home_settings SET token_enc = ?').run('legacy-token');
  rotateDatabase(file, 'old', 'new', { DEVOPS_ENCRYPTION_KEY: 'devops-only' });
  assert.equal(db.prepare('SELECT password_enc FROM devops_servers').get().password_enc, separate);
  assert.equal(decrypt(db.prepare('SELECT lat_enc FROM map_pins').get().lat_enc, 'new', ':').toString(), '55.7');
  assert.equal(db.prepare('SELECT lng_enc FROM map_pins').get().lng_enc, '37.6');
  assert.equal(db.prepare('SELECT token_enc FROM smart_home_settings').get().token_enc, 'legacy-token');
});
test('missing historical tables are accepted; wrong GCM key aborts', t => {
  const { db, file } = fixture(t);
  for (const table of new Set(FIELDS.map(f => f[0]))) if (table !== 'chatgpt_connections') db.exec(`DROP TABLE ${table}`);
  db.prepare('UPDATE chatgpt_connections SET credentials = ?').run(encrypt(Buffer.from('{}'), 'different', 'gcm'));
  assert.throws(() => rotateDatabase(file, 'old', 'new'), /cannot_reencrypt:chatgpt_connections/);
});
