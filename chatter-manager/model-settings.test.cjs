const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../admin-panel/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const handler = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleRequest').getText(ast);
function fixture(authenticated = true) {
  const calls = []; const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  const config = { proModels: [{ id: 'db-model', model: 'from-db', apiKey: '', hasApiKey: true }], hasAiApiKey: true };
  const ctx = vm.createContext({ URL, console: { warn() {}, error() {} },
    requireSession: () => authenticated, sameOrigin: () => true,
    sendJson: (response, status, body) => { response.status = status; response.body = body; },
    publicSettings: () => ({ proModels: [{ model: 'stale-env' }], pinecone: {}, webSearch: { engines: {} }, webReader: {} }),
    readJson: async () => ({ proModels: config.proModels }),
    backendInternalRequest: async (url, options) => { calls.push({ url, options }); if (url.includes('/model-')) return config; throw new Error('irrelevant-integration'); },
    applyConfiguration: () => { throw new Error('must_not_restart'); },
  });
  vm.runInContext(handler, ctx);
  return { ctx, res, calls, config };
}
test('models save uses the existing internal auth proxy and never restarts services', async () => {
  const { ctx, res, calls } = fixture();
  await ctx.handleRequest({ method: 'PUT', url: '/api/model-settings' }, res);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, '/internal/admin/model-settings');
  assert.equal(calls[0].options.method, 'PUT');
});
test('settings response replaces stale env models with the DB catalog', async () => {
  const { ctx, res } = fixture();
  await ctx.handleRequest({ method: 'GET', url: '/api/settings' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.proModels[0].model, 'from-db');
  assert.equal(res.body.hasAiApiKey, true);
});
test('export is authenticated, explicitly opts into secrets, and is not cached', async () => {
  const { ctx, res, calls } = fixture();
  await ctx.handleRequest({ method: 'GET', url: '/api/model-config/export?includeKeys=true' }, res);
  assert.equal(calls[0].url, '/internal/admin/model-config/export?includeKeys=true');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const blocked = fixture(false);
  await blocked.ctx.handleRequest({ method: 'GET', url: '/api/model-config/export?includeKeys=true' }, blocked.res);
  assert.equal(blocked.calls.length, 0);
});
test('model configuration import is forwarded once without applyConfiguration', async () => {
  const { ctx, res, calls } = fixture();
  await ctx.handleRequest({ method: 'POST', url: '/api/model-config/import' }, res);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/internal/admin/model-config/import');
});
