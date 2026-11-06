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
            "export let API_BASE='https://chatter.example/backend';globalThis.__setMcpApiBase=value=>API_BASE=value;export const apiFetch=async(url,options)=>{globalThis.__mcpCalls.push({url,...options});return {authorization_url:'https://auth.example/authorize'}};export const localMcpScope=()=>'fixture-account';export const syncLocalMcp=async()=>{globalThis.__mcpCalls.push({url:'local-sync'})};",
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
  const originalWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={electronAPI:{localMcpManage:async(payload:any)=>{
      (globalThis as any).__mcpCalls.push({url:'native-settings',payload});
      return payload.action==='settings'
        ? {env:{PRIVATE_KEY:'only-on-PC'},config_revision:'one',mode:'search',timeout_seconds:300}
        : {error:'fixture_restart_failed'};
    }}};
    const before=(globalThis as any).__mcpCalls.length;
    const settings=await fixture.exports.getLocalMcpSettings('fixture-id');
    assert.deepEqual(settings.env,{PRIVATE_KEY:'only-on-PC'});
    assert.deepEqual((globalThis as any).__mcpCalls.slice(before),[{
      url:'native-settings',payload:{action:'settings',scope:'fixture-account',id:'fixture-id'},
    }],'private settings use native IPC only, without HTTP or metadata sync');
    await assert.rejects(()=>fixture.exports.configureLocalMcp('fixture-id',{env:{}}),
      /fixture_restart_failed/);
    assert.equal((globalThis as any).__mcpCalls.at(-1).url,'local-sync',
      'persisted restart errors still resync public metadata before surfacing');
  } finally {
    (globalThis as any).window=originalWindow;
  }
  console.log(
    'PASS: desktop MCP OAuth uses current configured API base, preserves proxy prefix, and sends only the public callback URL',
  );
} finally {
  delete (globalThis as any).__mcpCalls;
  delete (globalThis as any).__setMcpApiBase;
}
