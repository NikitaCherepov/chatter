import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveLocalInput, pypiSpec, packageFromSource, parseLocalMcpEnvironment } = require('../src/main/local-mcp-spec.ts');
const { LocalMcpManager } = require('../src/main/local-mcp.ts');
assert.deepEqual(parseLocalMcpEnvironment('{"BASE_DIR":"D:/Documents"}'),{BASE_DIR:'D:/Documents'});
assert.deepEqual(parseLocalMcpEnvironment(''),{});
for(const invalid of ['{BASE_DIR=D:/Documents}','{"BASE_DIR":42}','[]','null'])
  assert.throws(()=>parseLocalMcpEnvironment(invalid));

for (const source of [
  'uvx windows-mcp serve',
  JSON.stringify({ command: 'uvx', args: ['windows-mcp', 'serve'] }),
  'uv tool run windows-mcp serve',
]) {
  const config = resolveLocalInput({ source });
  assert.equal(config.pypi, 'windows-mcp');
  assert.equal(config.tool, 'windows-mcp');
  assert.deepEqual(config.args, ['serve']);
}
assert.equal(pypiSpec('https://pypi.org/project/windows-mcp/0.8.8/'), 'windows-mcp==0.8.8');
assert.equal(pypiSpec('windows-mcp@0.8.8'), 'windows-mcp==0.8.8');
assert.equal(
  resolveLocalInput({ source: 'uvx --python 3.14 --from package-name==1.0 actual-tool serve' })
    .tool,
  'actual-tool',
);
assert.equal(resolveLocalInput({ source: 'uvx --python 3.14 foo' }).python, '3.14');
assert.deepEqual(
  resolveLocalInput({ source: 'uvx foo --index-url evil' }).args,
  ['--index-url', 'evil'],
  'tool args never become uv installation flags',
);
assert.equal(resolveLocalInput({ source: 'npx -y @example/mcp@1.0' }).npm, '@example/mcp@1.0');
assert.equal(
  resolveLocalInput({ source: JSON.stringify({ command: 'C:/own/uvx.exe', args: ['foo'] }) })
    .command,
  'C:/own/uvx.exe',
  'explicit executables preserved',
);
for (const source of [
  'uvx --with bad foo',
  'uvx --python',
  'uvx --from',
  'uvx --from foo ../bad',
  'uvx ../local',
  'uvx https://evil.example/pkg',
])
  assert.throws(() => resolveLocalInput({ source }), /mcp_/);
assert.throws(() => pypiSpec('--index-url=evil'), /invalid_python_package/);
const pkg = {
  registryType: 'pypi',
  identifier: 'windows-mcp',
  version: '0.8.8',
  transport: { type: 'stdio' },
  registryBaseUrl: 'https://pypi.org',
  packageArguments: [{ type: 'positional', value: 'serve' }],
};
assert.equal(resolveLocalInput({ package: pkg }).pypi, 'windows-mcp==0.8.8');
assert.equal(packageFromSource(JSON.stringify({ package: pkg })).identifier, 'windows-mcp');
assert.deepEqual(
  resolveLocalInput({ source: JSON.stringify({ package: pkg }) }).args,
  ['serve'],
  'approved catalog retains launch args',
);
assert.equal(packageFromSource('{"package":'), undefined);
assert.equal(
  packageFromSource(JSON.stringify({ package: { ...pkg, packageArguments: [null] } })),
  undefined,
);

assert.deepEqual(resolveLocalInput({ package: pkg }).args, ['serve']);
assert.throws(
  () => resolveLocalInput({ package: { ...pkg, registryBaseUrl: 'https://evil.example' } }),
  /unsupported_package/,
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatter-mcp-python-test-')),
  fixture = path.join(root, 'server.cjs');
await fs.writeFile(
  fixture,
  [
    "if(process.env.MCP_TEST_FAIL==='1')process.exit(2);",
    "const r=require('node:readline');const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');",
    "r.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'python-fixture',version:'1'}});",
    "if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:JSON.stringify({value:process.env.MCP_TEST_VALUE||'',pid:process.pid}),inputSchema:{type:'object',properties:{text:{type:'string'}}}}]});",
    "if(m.method==='tools/call'){if(m.params.arguments.text==='wait')setTimeout(()=>send(m.id,{content:[{type:'text',text:'late'}]}),10000);else send(m.id,{content:[{type:'text',text:m.params.arguments.text}]});}});",
  ].join('\n'),
);
const { uvRuntime } = require('../src/main/local-mcp-runtime.ts');
const previousFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes('api.github.com')) return new Response(JSON.stringify({ tag_name: '1.2.3' }));
    if (url.endsWith('.sha256')) return new Response('0'.repeat(64));
    return new Response('tampered archive');
  };
  await assert.rejects(
    () => uvRuntime(path.join(root, 'bad-runtime')),
    /mcp_runtime_checksum_mismatch/,
  );
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes('api.github.com')) return new Response(JSON.stringify({ tag_name: '1.2.3' }));
    return new Response(null, {
      status: 302,
      headers: { location: 'https://untrusted.example/runtime' },
    });
  };
  await assert.rejects(
    () => uvRuntime(path.join(root, 'bad-redirect')),
    /mcp_runtime_download_failed/,
  );
} finally {
  globalThis.fetch = previousFetch;
}
let installs = 0;
const installedDirs: string[] = [];
const manager = new LocalMcpManager(
  path.join(root, 'managed'),
  (s: string) => Buffer.from(s),
  (b: Buffer) => b.toString(),
  async () => {
    throw new Error('npm must not be used');
  },
  async (runtime: string, directory: string, spec: string, options: any) => {
    installs++;
    installedDirs.push(directory);
    assert.equal(spec, 'fake-mcp');
    assert.equal(options.python, '3.14');
    assert.ok(directory.startsWith(root));
    assert.ok(runtime.startsWith(root));
    await fs.writeFile(path.join(directory, 'owned-package'), 'installed');
    return {
      command: process.execPath,
      version: '1',
      path: path.dirname(process.execPath),
      env: { UV_PYTHON_INSTALL_DIR: path.join(runtime, 'python') },
    };
  },
);
try {
  const entry = await manager.install('test-account', {
    source: JSON.stringify({ command: 'uvx', args: ['--python', '3.14', 'fake-mcp', fixture] }),
  });
  assert.equal(entry.error, undefined);
  assert.equal(entry.tools.length, 1);
  assert.match(entry.source, /uvx fake-mcp/);
  const result = await manager.control('test-account', {
    local_id: entry.id,
    action: 'call',
    tool: 'echo',
    arguments: { text: 'Python bridge works' },
  });
  assert.equal(result.content[0].text, 'Python bridge works');
  assert.equal(installs, 1);
  await manager.closeAll();
  await manager.control('test-account', {
    local_id: entry.id,
    action: 'call',
    tool: 'echo',
    arguments: { text: 'cached' },
  });
  assert.equal(installs, 1, 'restart uses installed executable without reinstalling');
  assert.deepEqual((await manager.settings('test-account',entry.id)).env, {},
    'private settings exclude managed runtime environment');
  const env = {MCP_TEST_VALUE:'updated',API_KEY:'private-fixture'};
  const configured = await manager.configure('test-account',entry.id,{env});
  assert.equal(configured.error,undefined);
  assert.equal(configured.tools.length,1,'save rediscovers tools before returning');
  assert.equal(JSON.parse(configured.tools[0].description).value,'updated',
    'new process actually received changed environment');
  assert.deepEqual((await manager.settings('test-account',entry.id)).env,env);
  assert.equal(JSON.stringify(await manager.list('test-account')).includes('private-fixture'),false,
    'public metadata never includes private settings');
  await assert.rejects(()=>manager.settings('other-account',entry.id),/ENOENT/);
  const unchanged=await manager.configure('test-account',entry.id,{
    env:{API_KEY:'private-fixture',MCP_TEST_VALUE:'updated'},
  });
  assert.equal(unchanged.config_revision,configured.config_revision);
  assert.equal(unchanged.tools[0].description,configured.tools[0].description,
    'saving same values keeps the running process and tools');
  for(const invalid of [null,[],42,{INVALID:42}]) {
    await assert.rejects(()=>manager.configure('test-account',entry.id,{env:invalid}),/mcp_/);
    assert.equal((await manager.list('test-account'))[0].tools.length,1);
  }
  await assert.rejects(()=>manager.configure('test-account',entry.id,{
    expected_revision:entry.config_revision,env:{},
  }),/mcp_connection_changed/);
  const failed=await manager.configure('test-account',entry.id,{env:{MCP_TEST_FAIL:'1'}});
  assert.ok(failed.error,'failed restart persists an explicit error');
  assert.deepEqual((await manager.settings('test-account',entry.id)).env,{MCP_TEST_FAIL:'1'});
  const recovered=await manager.configure('test-account',entry.id,{env:{}});
  assert.equal(recovered.error,undefined);
  assert.equal(recovered.tools.length,1,'correcting configuration recovers tools automatically');
  assert.equal(JSON.parse(recovered.tools[0].description).value,'',
    'empty JSON removes previous user variables');
  assert.deepEqual((await manager.settings('test-account',entry.id)).env,{});
  assert.equal(installs,1,'environment edits never reinstall the package');
  const waiting=manager.control('test-account',{
    local_id:entry.id,action:'call',tool:'echo',arguments:{text:'wait'},
  }).then(()=>false,()=>true);
  for(let attempt=0;attempt<100&&!manager.busy.has(entry.id);attempt++)
    await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(manager.busy.has(entry.id));
  const duringCall=await manager.configure('test-account',entry.id,{
    env:{MCP_TEST_VALUE:'after-cancel'},
  });
  assert.equal(duringCall.error,undefined,'active call cancellation does not block rediscovery');
  assert.equal(duringCall.tools.length,1);
  assert.equal(await waiting,true,'changing environment stops the old call');

  const account = path.join(
    root,
    'managed',
    'accounts',
    require('node:crypto').createHash('sha256').update('test-account').digest('hex'),
  );
  const configFile = path.join(account, entry.id, 'config.bin');
  await manager.closeAll();
  const old = JSON.parse(await fs.readFile(configFile, 'utf8'));
  old.config = { command: 'uvx', args: ['--python', '3.14', 'fake-mcp', fixture], env: {} };
  old.metadata.tools = [];
  await fs.writeFile(configFile, JSON.stringify(old));
  await manager.control('test-account', { local_id: entry.id, action: 'discover' });
  assert.equal(installs, 2, 'refresh upgrades legacy raw uvx configuration');
  const upgraded = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(upgraded.config.pypi, 'fake-mcp');
  assert.notEqual(upgraded.config_revision, old.config_revision);
  await manager.control('test-account', {
    local_id: entry.id,
    action: 'call',
    tool: 'echo',
    arguments: { text: 'upgraded' },
  });
  assert.equal(installs, 2);
  await manager.remove('test-account', entry.id);
  for (const dir of installedDirs) await assert.rejects(() => fs.access(dir), /ENOENT/);
  assert.deepEqual(await manager.list('test-account'), []);
  console.log(
    'PASS: uvx/JSON/PyPI parsing, explicit executables, unsupported options, shared MCP discovery/calls, restart and removal',
  );
} finally {
  await manager.closeAll();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('chatter-mcp-python-test-'));
  await fs.rm(root, { recursive: true, force: true });
}
