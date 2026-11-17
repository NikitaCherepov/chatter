'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ts = require('../admin-panel/node_modules/typescript');
const Database = require('../backend-api/node_modules/better-sqlite3');
const { createQdrantBackup, validateQdrantBackup, snapshotPattern } = require('./qdrant-backup');
const execute = promisify(execFile);
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-qdrant-backup-'));
  const data = path.join(root, 'data');
  const backups = path.join(root, 'backups');
  const config = path.join(root, 'config');
  for (const directory of [data, backups, config]) fs.mkdirSync(directory);
  const database = path.join(data, 'chatter.db');
  const db = new Database(database);
  db.exec("CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES('original'); CREATE TABLE memory_chunks(id TEXT); CREATE TABLE vector_memory_collections(collection_name TEXT); INSERT INTO vector_memory_collections VALUES('chatter_memory');");
  db.close();
  const original = { config: { size: 3, distance: 'Cosine' }, points: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', vector: [0.25, -0.5, 1], payload: { text: 'Memory text', user_id: 81 } },
  ] };
  const collections = new Map([['chatter_memory', structuredClone(original)], ['unrelated', { points: [] }]]);
  const snapshots = new Map();
  const requests = [];
  let failUpload = false;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      requests.push({ method: req.method, url });
      assert.equal(req.headers['api-key'], 'test-only');
      const send = result => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', result })); };
      if (req.method === 'GET' && url.pathname === '/collections')
        return send({ collections: [...collections.keys()].map(name => ({ name })) });
      const name = parts[1];
      if (parts[0] === 'collections' && parts.length === 2 && req.method === 'DELETE') {
        collections.delete(name);
        return send(true);
      }
      if (req.method === 'POST' && parts.length === 3) {
        const nameOnServer = crypto.randomUUID() + '.snapshot';
        snapshots.set(nameOnServer, Buffer.from(JSON.stringify(collections.get(name))));
        return send({ name: nameOnServer });
      }
      if (req.method === 'POST' && parts[3] === 'upload') {
        assert.equal(url.searchParams.get('priority'), 'snapshot');
        assert.equal(url.searchParams.get('wait'), 'true');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.equal(body.length, Number(req.headers['content-length']));
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const file = body.subarray(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--' + boundary));
        assert.equal(crypto.createHash('sha256').update(file).digest('hex'), url.searchParams.get('checksum'));
        collections.set(name, JSON.parse(file));
        if (failUpload) {
          failUpload = false;
          res.writeHead(500).end('test failure after replacing the collection');
          return;
        }
        return send(true);
      }
      if (req.method === 'GET' && parts.length === 4)
        return res.end(snapshots.get(parts[3]));
      if (req.method === 'DELETE' && parts.length === 4) {
        snapshots.delete(parts[3]);
        return send(true);
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createQdrantBackup({ url: 'http://127.0.0.1:' + server.address().port, apiKey: 'test-only' });
  const runProcess = async (command, args) => (await execute(command, args, { maxBuffer: 1024 * 1024 })).stdout.trim();
  let failRestart = false;
  let starts = 0;
  const manager = vm.createContext({
    fs: { ...fs, chownSync() {}, lchownSync() {} }, path, crypto, process, console,
    DATA_DIR: data, DATABASE_FILE: database, UPLOADS_DIR: path.join(data, 'uploads'),
    CONFIG_DIR: config, BACKUPS_DIR: backups, BACKEND_ENV_FILE: path.join(config, 'backend.env'),
    BACKUP_CONFIG_FILES: ['backend.env'], snapshotPattern, validateQdrantBackup, runProcess,
    qdrantBackupClient: () => client, parseEnv: () => ({}),
    safeBackupName: name => /^chatter-[A-Za-z0-9._-]+\.tar\.gz$/.test(name) ? name : '',
    loadJson: (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } },
    atomicWrite: (file, content) => fs.writeFileSync(file, content), setOwnershipRecursive() {},
    stopDataServices: async () => {},
    applyConfiguration: async () => { starts++; if (failRestart) { failRestart = false; throw new Error('restart failed'); } },
  });
  const names = ['readBackupManifest', 'listBackups', 'memoryCollectionNames', 'createBackup', 'sqliteQuickCheck', 'inspectBackupArchive', 'importBackup', 'restoreBackup'];
  vm.runInContext(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(ast)).join('\n'), manager);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('chatter-qdrant-backup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const writeMessage = value => { const db = new Database(database); db.prepare('UPDATE messages SET text=?').run(value); db.close(); };
  const readMessage = () => { const db = new Database(database, { readonly: true }); try { return db.prepare('SELECT text FROM messages').get().text; } finally { db.close(); } };
  return { root, backups, database, collections, snapshots, requests, original, client, manager, runProcess,
    writeMessage, readMessage, failUpload: () => { failUpload = true; }, failRestart: () => { failRestart = true; }, starts: () => starts };
}

test('a downloaded archive survives import on a fresh installation and restores vectors, payload and SQLite', async t => {
  const f = await fixture(t);
  const backup = await f.manager.createBackup({ source: 'automatic' });
  const archive = path.join(f.backups, backup.name);
  const manifest = await f.manager.readBackupManifest(archive);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.includesMemoryVectors, true);
  assert.equal(manifest.source, 'automatic', 'scheduled backups use the same vector export');
  assert.deepEqual(Array.from(manifest.qdrant.collections, entry => entry.name), ['chatter_memory']);
  assert.equal(f.snapshots.size, 0, 'temporary Qdrant snapshots are cleaned');
  const upload = path.join(f.root, 'downloaded.tar.gz');
  fs.copyFileSync(archive, upload);
  const imported = await f.manager.importBackup(upload, 'downloaded.tar.gz');
  f.writeMessage('newer database');
  f.collections.delete('chatter_memory');
  await f.manager.restoreBackup(imported.name);
  assert.equal(f.readMessage(), 'original');
  assert.deepEqual(f.collections.get('chatter_memory'), f.original);
  assert.ok(f.collections.has('unrelated'), 'other Qdrant collections remain intact');
});

test('a corrupt snapshot is rejected during import before replacing either database', async t => {
  const f = await fixture(t);
  const backup = await f.manager.createBackup();
  const dir = path.join(f.root, 'tampered');
  fs.mkdirSync(dir);
  await f.runProcess('tar', ['-xzf', path.join(f.backups, backup.name), '-C', dir]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.appendFileSync(path.join(dir, manifest.qdrant.collections[0].file), 'tampered');
  const upload = path.join(f.root, 'tampered.tar.gz');
  await f.runProcess('tar', ['-czf', upload, '-C', dir, 'manifest.json', 'database.sqlite', 'qdrant']);
  await assert.rejects(f.manager.importBackup(upload, 'test.tar.gz'), /integrity check failed/);
  assert.equal(f.readMessage(), 'original');
  assert.deepEqual(f.collections.get('chatter_memory'), f.original);
});

test('a failed Qdrant upload rolls back SQLite and a collection already partially overwritten', async t => {
  const f = await fixture(t);
  const backup = await f.manager.createBackup();
  f.writeMessage('keep this');
  const newer = { points: [{ id: 2, vector: [1, 0, 0], payload: { text: 'Keep newer memory' } }] };
  f.collections.set('chatter_memory', newer);
  f.failUpload();
  await assert.rejects(f.manager.restoreBackup(backup.name), /HTTP 500/);
  assert.equal(f.readMessage(), 'keep this');
  assert.deepEqual(f.collections.get('chatter_memory'), newer);
});

test('a failed restart removes newly created collections and restores the previous SQLite', async t => {
  const f = await fixture(t);
  const backup = await f.manager.createBackup();
  f.writeMessage('keep this');
  f.collections.delete('chatter_memory');
  f.failRestart();
  await assert.rejects(f.manager.restoreBackup(backup.name), /restart failed/);
  assert.equal(f.readMessage(), 'keep this');
  assert.equal(f.collections.has('chatter_memory'), false);
  assert.equal(f.starts(), 2, 'previous data is started after rollback');
});

test('legacy SQLite-only imports and archives remain supported', async t => {
  const f = await fixture(t);
  const upload = path.join(f.root, 'old.db');
  fs.copyFileSync(f.database, upload);
  const imported = await f.manager.importBackup(upload, 'old.db');
  const manifest = await f.manager.readBackupManifest(path.join(f.backups, imported.name));
  assert.equal(manifest.schemaVersion, 1);
  f.writeMessage('newer');
  const newer = { points: [{ vector: [1, 0, 0] }] };
  f.collections.set('chatter_memory', newer);
  await f.manager.restoreBackup(imported.name);
  assert.equal(f.readMessage(), 'original');
  assert.deepEqual(f.collections.get('chatter_memory'), newer, 'legacy archives have no vectors to restore');
});

test('manifest rejects unsafe paths, duplicate collections and missing snapshots', async t => {
  const f = await fixture(t);
  const manifest = await f.client.capture(f.root, ['chatter_memory']);
  await assert.rejects(validateQdrantBackup(f.root, { collections: [{ ...manifest.collections[0], file: '../escape.snapshot' }] }), /Invalid/);
  await assert.rejects(validateQdrantBackup(f.root, { collections: [...manifest.collections, ...manifest.collections] }), /Invalid/);
  fs.unlinkSync(path.join(f.root, manifest.collections[0].file));
  await assert.rejects(validateQdrantBackup(f.root, manifest), /ENOENT/);
});

test('all registered memory collections are included, and an empty Qdrant is supported', async t => {
  const f = await fixture(t);
  const db = new Database(f.database);
  db.exec("INSERT INTO vector_memory_collections VALUES('older_memory'); CREATE TABLE system_settings(key TEXT,value_json TEXT);");
  db.prepare('INSERT INTO system_settings VALUES(?,?)').run('vector_memory_settings', JSON.stringify({ activeCollection: 'next_memory' }));
  db.close();
  f.collections.set('older_memory', { points: [{ vector: [0, 1, 0] }] });
  f.collections.set('next_memory', { points: [] });
  const backup = await f.manager.createBackup();
  const manifest = await f.manager.readBackupManifest(path.join(f.backups, backup.name));
  assert.deepEqual(Array.from(manifest.qdrant.collections, entry => entry.name).sort(),
    ['chatter_memory', 'next_memory', 'older_memory']);
  f.collections.clear();
  const empty = await f.manager.createBackup();
  const emptyManifest = await f.manager.readBackupManifest(path.join(f.backups, empty.name));
  assert.equal(emptyManifest.qdrant.collections.length, 0);
  f.collections.set('chatter_memory', f.original);
  await f.manager.restoreBackup(empty.name);
  assert.equal(f.collections.has('chatter_memory'), false, 'restoring empty memory removes later vectors');
});

test('an unavailable Qdrant fails the backup instead of silently publishing a database-only archive', async t => {
  const f = await fixture(t);
  const failing = createQdrantBackup({
    url: 'http://127.0.0.1',
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  });
  f.manager.qdrantBackupClient = () => failing;
  await assert.rejects(f.manager.createBackup(), /HTTP 503/);
  assert.deepEqual(fs.readdirSync(f.backups), [], 'partial archives are cleaned');
  assert.equal(f.readMessage(), 'original');
});
