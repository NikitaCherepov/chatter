const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../admin-panel/node_modules/typescript');
const ast = ts.createSourceFile('server.js', fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const handler = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleRequest').getText(ast);
function fixture({ authenticated = true, body = { kind: 'jwt', currentPassword: 'test-only', confirm: true }, blocked = false } = {}) {
  const calls = [];
  const ctx = vm.createContext({ URL, console,
    sameOrigin: () => true, requireSession: () => authenticated,
    sendJson: (res, status, result) => { res.status = status; res.body = result; },
    readJson: async () => body, loginAllowed: () => true, clientIp: () => 'test', recordFailedLogin: () => {},
    authConfig: {}, verifyPassword: password => password === 'test-only',
    serverUpdateInProgress: () => blocked, applyPromise: null, backupPromise: null, restorePromise: null,
    secretRotation: {
      blocked: () => blocked, status: () => ({ status: blocked ? 'recovery_required' : 'idle' }),
      start: kind => { calls.push(kind); return { status: 'queued', kind }; },
      recover: async () => { calls.push('recover'); },
    },
  });
  vm.runInContext(handler, ctx);
  const res = {};
  return { ctx, res, calls };
}
test('rotation endpoints require an admin session', async () => {
  const f = fixture({ authenticated: false });
  await f.ctx.handleRequest({ method: 'POST', url: '/api/security/rotation' }, f.res);
  assert.deepEqual(f.calls, []);
});
test('wrong current password cannot rotate', async () => {
  const f = fixture({ body: { kind: 'jwt', currentPassword: 'wrong', confirm: true } });
  await f.ctx.handleRequest({ method: 'POST', url: '/api/security/rotation' }, f.res);
  assert.equal(f.res.status, 403); assert.deepEqual(f.calls, []);
});
test('explicit confirmation is required', async () => {
  const f = fixture({ body: { kind: 'jwt', currentPassword: 'test-only' } });
  await f.ctx.handleRequest({ method: 'POST', url: '/api/security/rotation' }, f.res);
  assert.equal(f.res.status, 400); assert.deepEqual(f.calls, []);
});
test('accepted request returns 202; clients cannot supply replacement secret values', async () => {
  const f = fixture({ body: { kind: 'encryption', currentPassword: 'test-only', confirm: true, newKey: 'ignored' } });
  await f.ctx.handleRequest({ method: 'POST', url: '/api/security/rotation' }, f.res);
  assert.equal(f.res.status, 202); assert.deepEqual(f.calls, ['encryption']);
  assert.equal(JSON.stringify(f.res.body).includes('ignored'), false);
});
test('pending recovery blocks normal APIs, not status and password-confirmed recovery', async () => {
  const f = fixture({ blocked: true });
  await f.ctx.handleRequest({ method: 'PUT', url: '/api/settings' }, f.res); assert.equal(f.res.status, 503);
  await f.ctx.handleRequest({ method: 'GET', url: '/api/security/rotation' }, f.res); assert.equal(f.res.status, 200);
  await f.ctx.handleRequest({ method: 'POST', url: '/api/security/rotation/recover' }, f.res); assert.equal(f.res.status, 202);
  assert.deepEqual(f.calls, ['recover']);
});
test('backend Docker entrypoint never imports the application while recovery marker exists', () => {
  const calls = []; let exists = true; let retry;
  const source = fs.readFileSync(path.join(__dirname, '../backend-api/scripts/start.cjs'), 'utf8');
  vm.runInNewContext(source, { process: { env: { API_DB_PATH: '/data/chatter.db' } },
    setTimeout: fn => { retry = fn; },
    require: name => name === 'node:fs' ? { existsSync: () => exists } : name === 'node:path' ? path.posix : calls.push(name),
  });
  assert.deepEqual(calls, []); exists = false; retry(); assert.deepEqual(calls, ['../dist/server.js']);
});
test('env replacement updates duplicate definitions instead of leaving the old key active', t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-rotation-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'backend.env');
  fs.writeFileSync(file, 'ENCRYPTION_KEY=old-first\nUNRELATED=keep\nENCRYPTION_KEY=old-last\n');
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'updateEnvFileValue').getText(ast);
  const ctx = vm.createContext({ fs, atomicWrite: (target, content) => fs.writeFileSync(target, content) });
  vm.runInContext(fn, ctx); ctx.updateEnvFileValue(file, 'ENCRYPTION_KEY', 'new-test-only');
  const result = fs.readFileSync(file, 'utf8');
  assert.equal(result.includes('old-'), false); assert.equal(result.includes('UNRELATED=keep'), true);
  assert.equal(result.split('ENCRYPTION_KEY=new-test-only').length, 3);
});
