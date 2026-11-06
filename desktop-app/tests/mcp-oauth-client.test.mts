import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url),
  esbuild = require('../../node_modules/esbuild');
const build = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/lib/mcp-service.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
  plugins: [
    {
      name: 'api-fixture',
      setup(b: any) {
        b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'mock-api', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          loader: 'js',
          contents:
            "export let API_BASE='https://chatter.example/backend';globalThis.__setMcpApiBase=value=>API_BASE=value;export const apiFetch=async(url,options)=>{globalThis.__mcpCalls.push({url,...options});return {authorization_url:'https://auth.example/authorize'}};export const localMcpScope=()=>'';export const syncLocalMcp=async()=>{};",
        }));
      },
    },
  ],
});
const fixture: any = { exports: {} };
(globalThis as any).__mcpCalls = [];
try {
  new Function('module', 'exports', build.outputFiles[0].text)(fixture, fixture.exports);
  for (const base of [
    'https://chatter.example/backend',
    'https://chatter.example/backend/',
    'https://chatter.example/backend///',
    'https://chatter.example',
  ]) {
    (globalThis as any).__setMcpApiBase(base);
    await fixture.exports.authorizeMcp(17);
    const call = (globalThis as any).__mcpCalls.at(-1);
    assert.equal(call.url, '/api/v1/mcp/connections/17/oauth');
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body), {
      callback_url: base.replace(/\/+$/, '') + '/mcp/oauth/callback',
    });
  }
  console.log(
    'PASS: desktop MCP OAuth uses current configured API base, preserves proxy prefix, and sends only the public callback URL',
  );
} finally {
  delete (globalThis as any).__mcpCalls;
  delete (globalThis as any).__setMcpApiBase;
}
