import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const setup = ast.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === 'setupContentSecurityPolicy');
assert.ok(setup, 'test must execute the actual application CSP setup');
const setupScript = ts.transpileModule(setup.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

export function getTestPolicy(isPackaged = true): string {
  let onHeaders: any;
  new Function('app', 'session', 'serverCspSources', `${setupScript}; setupContentSecurityPolicy();`)(
    { isPackaged },
    { defaultSession: { webRequest: { onHeadersReceived: (callback: any) => { onHeaders = callback; } } } },
    () => ['https://chatter.example.test', 'wss://chatter.example.test'],
  );
  let result: any;
  onHeaders({ resourceType: 'mainFrame', responseHeaders: { 'content-security-policy': ['old'], 'X-Test': ['keep'] } }, (headers: any) => { result = headers; });
  assert.deepEqual(result.responseHeaders['X-Test'], ['keep']);
  assert.equal(result.responseHeaders['content-security-policy'], undefined);
  const original = { 'X-Asset': ['keep'] };
  onHeaders({ resourceType: 'image', responseHeaders: original }, (headers: any) => { assert.equal(headers.responseHeaders, original); });
  return result.responseHeaders['Content-Security-Policy'][0];
}

for (const packaged of [false, true]) {
  const policy = getTestPolicy(packaged);
  const directives = Object.fromEntries(policy.split('; ').map(line => {
    const [name, ...values] = line.split(' ');
    return [name, values];
  }));
  assert.ok(directives['img-src'].includes('https:'));
  assert.ok(directives['img-src'].includes('https://chatter.example.test'));
  assert.ok(!directives['img-src'].includes('http:'), 'do not allow arbitrary insecure image origins');
  for (const name of ['script-src', 'connect-src', 'media-src', 'frame-src']) assert.ok(!directives[name].includes('https:'), name);
  assert.deepEqual(directives['frame-src'], ["'none'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  if (packaged) assert.deepEqual(directives['script-src'], ["'self'"]);
}
console.log('CSP: external HTTPS images allowed; scripts, fetch, frames and media remain restricted');
