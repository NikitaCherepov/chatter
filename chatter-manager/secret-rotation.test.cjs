const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretRotation } = require('./secret-rotation');
const { rotateDatabase, encrypt, decrypt } = require('../backend-api/scripts/rotate-encryption.cjs');
const Database = require('../backend-api/node_modules/better-sqlite3');

function fixture(t, hooks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-rotation-'));
  const configDir = path.join(root, 'config'); const dataDir = path.join(root, 'data');
  fs.mkdirSync(configDir); fs.mkdirSync(dataDir);
  const database = path.join(dataDir, 'chatter.db');
  let db = new Database(database);
  db.exec('CREATE TABLE api_keys (id INTEGER PRIMARY KEY, key_encrypted TEXT); CREATE TABLE chats (id INTEGER PRIMARY KEY, text TEXT);');
  db.prepare('INSERT INTO api_keys VALUES (?, ?)').run(4, encrypt(Buffer.from('provider-test-key'), 'old-key', '::'));
  db.prepare('INSERT INTO chats VALUES (?, ?)').run(19, 'retained'); db.close();
  fs.writeFileSync(path.join(configDir, 'backend.env'), 'API_JWT_SECRET=old-jwt\nBACKEND_INTERNAL_TOKEN=old-token\nENCRYPTION_KEY=old-key\nUNRELATED=keep\n');
  fs.writeFileSync(path.join(configDir, 'telegram.env'), 'BACKEND_INTERNAL_TOKEN=old-token\nTELEGRAM_TOKEN=bot-test-only\n');
  const calls = [];
  const parseEnv = file => Object.fromEntries((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const atomicWrite = (file, content) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, file); };
  const options = {
    configDir, dataDir, atomicWrite, parseEnv, exclusive: fn => Promise.resolve().then(fn),
    updateEnv: (file, name, value) => atomicWrite(file, Object.entries({ ...parseEnv(file), [name]: value }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'),
    preflight: async () => { calls.push('preflight'); },
    services: async () => ['backend', 'telegram-bot'],
    stop: async () => { calls.push('stop'); },
    restart: async services => {
      calls.push('restart:' + services.join(','));
      assert.equal(fs.existsSync(path.join(dataDir, '.secret-rotation-maintenance')), false);
      const source = parseEnv(path.join(configDir, 'backend.env')).ENCRYPTION_KEY;
      const db = new Database(database);
      try { assert.equal(decrypt(db.prepare('SELECT key_encrypted FROM api_keys').get().key_encrypted, source, '::').toString(), 'provider-test-key'); }
      finally { db.close(); }
    },
    check: async () => { calls.push('check'); },
    snapshot: async file => { calls.push('snapshot'); fs.copyFileSync(database, file); },
    backup: async () => { calls.push('backup'); return { name: 'test-backup.tar.gz' }; },
    transform: async (file, oldKey, newKey, backend, verifyOnly) => rotateDatabase(file, oldKey, newKey, backend, verifyOnly),
    ...hooks,
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rotation = createSecretRotation(options);
  const env = () => parseEnv(path.join(configDir, 'backend.env'));
  return { root, configDir, dataDir, database, calls, env, options, rotation, parseEnv, atomicWrite };
}
async function wait(rotation) {
  for (let i = 0; i < 200; i++) {
    const state = rotation.status();
    if (['complete', 'failed', 'recovery_required'].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('rotation timed out');
}
for (const kind of ['jwt', 'internal', 'encryption']) test(`${kind}: backup, matched configuration, stable data and service restart`, async t => {
  const f = fixture(t); const before = f.env();
  f.rotation.start(kind);
  assert.throws(() => f.rotation.start(kind), /in_progress/);
  const result = await wait(f.rotation);
  assert.equal(result.status, 'complete');
  assert.equal(result.backup, 'test-backup.tar.gz');
  const name = { jwt: 'API_JWT_SECRET', internal: 'BACKEND_INTERNAL_TOKEN', encryption: 'ENCRYPTION_KEY' }[kind];
  assert.match(f.env()[name], /^[a-f\d]{64}$/); assert.notEqual(f.env()[name], before[name]);
  for (const key of Object.keys(before)) if (key !== name) assert.equal(f.env()[key], before[key]);
  if (kind === 'internal') assert.equal(f.parseEnv(path.join(f.configDir, 'telegram.env')).BACKEND_INTERNAL_TOKEN, f.env()[name]);
  const db = new Database(f.database); assert.equal(db.prepare('SELECT text FROM chats WHERE id=19').get().text, 'retained'); db.close();
  assert.ok(f.calls.indexOf('backup') < f.calls.findIndex(c => c.startsWith('restart')));
  assert.equal(JSON.stringify(result).includes(f.env()[name]), false);
});
test('bad ciphertext leaves the original DB/key readable and rolls back', async t => {
  const f = fixture(t, { transform: async () => { throw new Error('test-secret-error'); } });
  f.rotation.start('encryption');
  const result = await wait(f.rotation);
  assert.equal(result.status, 'failed'); assert.equal(f.env().ENCRYPTION_KEY, 'old-key');
  assert.equal(JSON.stringify(result).includes('test-secret-error'), false);
  assert.equal(f.rotation.blocked(), false);
});
test('disk/image preflight failure does not stop services or mutate secrets', async t => {
  const f = fixture(t, { preflight: async () => { throw new Error('no space'); } });
  f.rotation.start('jwt'); const result = await wait(f.rotation);
  assert.equal(result.status, 'failed'); assert.equal(f.env().API_JWT_SECRET, 'old-jwt');
  assert.deepEqual(f.calls, []);
});
test('restart failure after commit retains new key and retry does not lose new writes', async t => {
  let fail = true;
  const f = fixture(t, { check: async () => { if (fail) throw new Error('offline'); } });
  f.rotation.start('encryption'); assert.equal((await wait(f.rotation)).status, 'recovery_required');
  const nextKey = f.env().ENCRYPTION_KEY; assert.notEqual(nextKey, 'old-key');
  const db = new Database(f.database); db.prepare('INSERT INTO chats VALUES (?, ?)').run(20, 'after commit'); db.close();
  fail = false;
  const recovered = createSecretRotation(f.options);
  assert.equal((await recovered.recover()).status, 'complete'); assert.equal(f.env().ENCRYPTION_KEY, nextKey);
  const verify = new Database(f.database); assert.equal(verify.prepare('SELECT text FROM chats WHERE id=20').get().text, 'after commit'); verify.close();
});
test('manager crash between DB and env publication restores old pair on startup', async t => {
  const f = fixture(t);
  const id = '11111111-1111-4111-8111-111111111111';
  const dir = path.join(f.configDir, `.secret-rotation-${id}`); fs.mkdirSync(dir);
  for (const name of ['backend.env', 'telegram.env']) fs.copyFileSync(path.join(f.configDir, name), path.join(dir, name));
  fs.copyFileSync(f.database, path.join(dir, 'database.sqlite'));
  const owner = fs.statSync(f.database);
  rotateDatabase(f.database, 'old-key', 'new-key');
  fs.writeFileSync(path.join(f.dataDir, '.secret-rotation-maintenance'), id);
  f.atomicWrite(path.join(f.configDir, 'secret-rotation.json'), JSON.stringify({ id, kind: 'encryption', status: 'running', phase: 'publishing', services: ['backend', 'telegram-bot'], files: ['backend.env', 'telegram.env'], snapshotReady: true, uid: owner.uid, gid: owner.gid, mode: owner.mode & 0o777 }));
  const recovered = createSecretRotation(f.options);
  assert.equal(recovered.blocked(), true); assert.equal((await recovered.recover()).status, 'failed');
  assert.equal(f.env().ENCRYPTION_KEY, 'old-key'); assert.equal(recovered.blocked(), false);
});
test('corrupt journal fails closed instead of starting a new operation', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.configDir, 'secret-rotation.json'), 'bad-json');
  assert.equal(f.rotation.status().status, 'recovery_required'); assert.equal(f.rotation.blocked(), true);
  assert.throws(() => f.rotation.start('jwt'), /in_progress/);
});
test('orphan maintenance marker fails closed; recovery does not guess a key', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dataDir, '.secret-rotation-maintenance'), 'interrupted');
  assert.equal(f.rotation.status().status, 'recovery_required'); assert.equal(f.rotation.blocked(), true);
  assert.throws(() => f.rotation.start('jwt'), /in_progress/);
  await f.rotation.recover();
  assert.equal(f.rotation.blocked(), true); assert.equal(f.env().ENCRYPTION_KEY, 'old-key');
});
test('runtime mismatch stops before backup, service stop or JWT replacement', async t => {
  const f = fixture(t, { preflight: async () => { throw new Error('running_secret_config_mismatch'); } });
  f.rotation.start('jwt'); const result = await wait(f.rotation);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'running_secret_config_mismatch');
  assert.equal(f.env().API_JWT_SECRET, 'old-jwt'); assert.deepEqual(f.calls, []);
});
test('committed recovery refuses to start services with an unreadable database', async t => {
  let fail = true;
  const f = fixture(t, { validate: async () => { if (fail) throw new Error('cannot_reencrypt:api_keys.key_encrypted:row_4'); } });
  f.rotation.start('jwt'); const result = await wait(f.rotation);
  assert.equal(result.status, 'recovery_required'); assert.equal(result.phase, 'committed');
  assert.equal(f.calls.some(call => call.startsWith('restart')), false);
  const jwt = f.env().API_JWT_SECRET;
  fail = false; await f.rotation.recover();
  assert.equal(f.rotation.status().status, 'complete'); assert.equal(f.env().API_JWT_SECRET, jwt);
});
