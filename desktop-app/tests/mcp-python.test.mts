import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveLocalInput, pypiSpec, packageFromSource, parseLocalMcpEnvironment, localMcpInputSource, normalizeMcpEndpoint } = require('../src/main/local-mcp-spec.ts');
const { LocalMcpManager } = require('../src/main/local-mcp.ts');
const { localMcpLaunchArgs } = require('../src/main/local-mcp-spec.ts');
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
  localMcpInputSource({ source: JSON.stringify({ command: 'C:/tools/uvx.exe', args: ['windows-mcp'] }) }).key,
  localMcpInputSource({ source: 'uvx windows-mcp' }).key,
);
assert.equal(
  localMcpInputSource({ source: 'uvx Windows_MCP' }).key,
  localMcpInputSource({ source: 'pypi:windows-mcp==0.8.8' }).key,
);
assert.equal(
  localMcpInputSource({ source: 'npx -y @example/tools@1.0.0' }).key,
  localMcpInputSource({ source: 'npx -y @example/tools@2.0.0' }).key,
);
assert.equal(
  localMcpInputSource({ source: 'uvx --from git+https://github.com/Example/Tool.git@main entry' }).key,
  localMcpInputSource({ source: 'uvx --from git+https://github.com/example/tool@release entry' }).key,
);
assert.notEqual(
  normalizeMcpEndpoint('https://example.test/mcp?account=1'),
  normalizeMcpEndpoint('https://example.test/mcp?account=2'),
);
assert.equal(
  resolveLocalInput({ source: 'uvx --python 3.14 --from package-name==1.0 actual-tool serve' })
    .tool,
  'actual-tool',
);
assert.equal(resolveLocalInput({ source: 'uvx --python 3.14 foo' }).python, '3.14');
const gitSource = 'git+https://github.com/example/local-mcp.git@feature/control';
const gitConfig = resolveLocalInput({
  source: 'uvx --python 3.14 --from ' + gitSource + ' local-mcp serve --no-control',
});
assert.equal(gitConfig.git, gitSource);
assert.equal(gitConfig.pypi, undefined);
assert.equal(gitConfig.tool, 'local-mcp');
assert.equal(gitConfig.python, '3.14');
assert.deepEqual(gitConfig.args, ['serve', '--no-control']);
for (const source of ['git+http://example.com/mcp.git', 'git+https://user@example.com/mcp.git', 'git+file:///mcp']) {
  assert.throws(() => resolveLocalInput({ source: 'uvx --from ' + source + ' local-mcp' }), /mcp_invalid_git_package/);
}
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
const bareWindows = resolveLocalInput({ package: { ...pkg, packageArguments: undefined } });
assert.deepEqual(localMcpLaunchArgs(bareWindows), ['serve']);
assert.deepEqual(localMcpLaunchArgs({ ...bareWindows, installed_version: '0.8.1' }), ['serve']);
assert.deepEqual(localMcpLaunchArgs({ ...bareWindows, installed_version: '0.7.0' }), []);
assert.deepEqual(localMcpLaunchArgs({ ...bareWindows, args: ['serve', '--no-control'] }), [
  'serve',
  '--no-control',
]);
assert.deepEqual(localMcpLaunchArgs({ ...bareWindows, pypi: 'another-mcp==0.8.8' }), []);
assert.throws(
  () => resolveLocalInput({ package: { ...pkg, registryBaseUrl: 'https://evil.example' } }),
  /unsupported_package/,
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatter-mcp-python-test-')),
  fixture = path.join(root, 'server.cjs');
await fs.writeFile(
  fixture,
  [
    "if(process.env.MCP_TEST_FAIL==='1'){console.error('fixture startup failed: '+process.env.API_KEY);process.exit(2);}",
    "const r=require('node:readline');const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');",
    "r.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'python-fixture',version:'1'}});",
    "if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:JSON.stringify({value:process.env.MCP_TEST_VALUE||'',args:process.argv.slice(2),pid:process.pid}),inputSchema:{type:'object',properties:{text:{type:'string'}}}}]});",
    "if(m.method==='tools/call'){if(m.params.arguments.text==='wait')setTimeout(()=>send(m.id,{content:[{type:'text',text:'late'}]}),10000);else send(m.id,{content:[{type:'text',text:m.params.arguments.text}]});}});",
  ].join('\n'),
);
const { uvRuntime, readGithubMcpManifest } = require('../src/main/local-mcp-runtime.ts');
const previousFetch = globalThis.fetch;
try {
  const manifestUrl = 'https://raw.githubusercontent.com/CursorTouch/Windows-MCP/HEAD/server.json';
  let githubRequests = 0;
  globalThis.fetch = async (input: any, options?: RequestInit) => {
    githubRequests++;
    assert.equal(options?.redirect, 'error');
    if (String(input) === manifestUrl.replace('server.json', 'README.md'))
      return new Response(['```sh', 'claude mcp add windows -- uvx windows-mcp serve',
        'uvx windows-mcp serve --transport sse', 'uvx other-mcp start', '```'].join('\n'));
    assert.equal(String(input), manifestUrl);
    return Response.json({
      name: 'io.github.CursorTouch/Windows-MCP',
      version: '1.0.1',
      packages: [
        { registryType: 'pypi', identifier: 'windows-mcp', version: '0.8.8', transport: { type: 'stdio' },
          environmentVariables: [{ name: 'MODE', default: 'auto' }] },
        { registryType: 'oci', identifier: 'unsupported', transport: { type: 'stdio' } },
      ],
      remotes: [
        { type: 'streamable-http', url: 'https://fixture.example/mcp' },
        { type: 'streamable-http', url: 'https://credential@fixture.example/mcp' },
      ],
    });
  };
  const github = await readGithubMcpManifest('https://github.com/CursorTouch/Windows-MCP.git');
  assert.equal(github.items.length, 2);
  assert.equal(github.items[0].package.version, '0.8.8');
  assert.equal(github.items[0].package.environmentVariables[0].default, 'auto');
  assert.deepEqual(github.items[0].package.packageArguments, [{ type: 'positional', value: 'serve' }]);
  assert.equal(github.items[1].url, 'https://fixture.example/mcp');
  await assert.rejects(() => readGithubMcpManifest('https://github.com@private.example/x/y'), /invalid_github_url/);
  assert.equal(githubRequests, 2);
  globalThis.fetch = async () => new Response('Not found', { status: 404 });
  assert.deepEqual(await readGithubMcpManifest('https://github.com/CursorTouch/Windows-MCP'), { items: [] });
  globalThis.fetch = async () => new Response('x'.repeat(100_001));
  await assert.rejects(() => readGithubMcpManifest('https://github.com/CursorTouch/Windows-MCP'), /invalid_manifest/);
  globalThis.fetch = async () => new Response(null, { status: 429 });
  await assert.rejects(() => readGithubMcpManifest('https://github.com/CursorTouch/Windows-MCP'), /github_unavailable/);
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
let gitCommit = 'a'.repeat(40);
let gitStartupFails = false;
const installedDirs: string[] = [];
const manager = new LocalMcpManager(
  path.join(root, 'managed'),
  (s: string) => Buffer.from(s),
  (b: Buffer) => b.toString(),
  async (runtime: string, directory: string, spec: string) => {
    installs++;
    installedDirs.push(directory);
    assert.ok(runtime.startsWith(root) && directory.startsWith(root));
    assert.match(spec, /^@example\/fixture(?:@\d+\.0\.0)?$/);
    const version = spec.split('@').at(2) || '1.0.0';
    const entry = path.join(directory, 'server.cjs');
    if (version === '3.0.0') await fs.writeFile(entry, 'process.exit(2);');
    else await fs.copyFile(fixture, entry);
    return {
      command: process.execPath,
      version,
      entry,
      path: path.dirname(process.execPath),
    };
  },
  async (runtime: string, directory: string, spec: string, options: any) => {
    installs++;
    installedDirs.push(directory);
    assert.ok(/^fake-mcp(?:==2\.0\.0)?$/.test(spec) || spec === gitSource);
    if (options.python !== undefined) assert.equal(options.python, '3.14');
    assert.ok(directory.startsWith(root));
    assert.ok(runtime.startsWith(root));
    await fs.writeFile(path.join(directory, 'owned-package'), 'installed');
    return {
      command: process.execPath,
      version: spec.split('==')[1] || '1.0.0',
      commit: spec === gitSource ? gitCommit : undefined,
      path: path.dirname(process.execPath),
      env: {
        UV_PYTHON_INSTALL_DIR: path.join(runtime, 'python'),
        ...(spec === gitSource && gitStartupFails ? { MCP_TEST_FAIL: '1' } : {}),
      },
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

  const phases: string[] = [];
  const gitEntry = await manager.install('test-account', {
    source: JSON.stringify({
      command: 'uvx',
      args: ['--python', '3.14', '--from', gitSource, 'local-mcp', fixture, 'serve', '--no-control'],
    }),
    env: { API_KEY: 'git-private-key' },
  }, (phase: string) => phases.push(phase));
  assert.deepEqual(phases, ['installing', 'connecting']);
  assert.equal(gitEntry.git_commit, 'a'.repeat(40));
  assert.equal(gitEntry.tools.length, 1);
  const previousPackage = installedDirs.at(-1)!;
  const approval = { allow_all: false, tools: ['echo'], resources: [] };
  await manager.configure('test-account', gitEntry.id, { approval_policy: approval });

  gitCommit = 'b'.repeat(40);
  gitStartupFails = true;
  const failedUpdate = await manager.update('test-account', gitEntry.id);
  assert.equal(failedUpdate.git_commit, gitEntry.git_commit);
  assert.equal(failedUpdate.config_revision, gitEntry.config_revision);
  assert.match(failedUpdate.error, /fixture startup failed: \[redacted\]/);
  assert.equal(failedUpdate.error.includes('git-private-key'), false);
  await fs.access(previousPackage);
  await assert.rejects(() => fs.access(installedDirs.at(-1)!), /ENOENT/);
  const resultAfterFailure = await manager.control('test-account', {
    local_id: gitEntry.id, action: 'call', tool: 'echo', arguments: { text: 'old package still works' },
  });
  assert.equal(resultAfterFailure.content[0].text, 'old package still works');

  gitStartupFails = false;
  phases.length = 0;
  const updated = await manager.update('test-account', gitEntry.id, (phase: string) => phases.push(phase));
  assert.deepEqual(phases, ['installing', 'connecting']);
  assert.equal(updated.git_commit, gitCommit);
  assert.notEqual(updated.config_revision, gitEntry.config_revision);
  assert.deepEqual(updated.approval_policy, approval);
  assert.deepEqual((await manager.settings('test-account', gitEntry.id)).env, { API_KEY: 'git-private-key' });
  assert.equal(updated.error, undefined);
  await assert.rejects(() => fs.access(previousPackage), /ENOENT/);
  await manager.remove('test-account', gitEntry.id);
  for (const directory of installedDirs) await assert.rejects(() => fs.access(directory), /ENOENT/);
  const packageManifest = {
    registryType: 'pypi',
    identifier: 'fake-mcp',
    transport: { type: 'stdio' },
    environmentVariables: [
      { name: 'MCP_TEST_VALUE', description: 'Sample value', default: 'balanced' },
      { name: 'EXTRA_OPTION', description: 'Optional setting' },
    ],
    packageArguments: [
      { type: 'positional', value: fixture },
      { type: 'named', name: '--policy', default: 'auto' },
    ],
  };
  const manifestEntry = await manager.install('test-account', {
    package: packageManifest,
    env: { CUSTOM_ENV: 'kept' },
  });
  assert.equal(manifestEntry.error, undefined);
  assert.equal(manifestEntry.manifest, undefined, 'launch configuration stays out of the summary');
  const manifestSettings = await manager.settings('test-account', manifestEntry.id);
  assert.deepEqual(manifestSettings.manifest.package, packageManifest);
  assert.deepEqual(manifestSettings.manifest.values, {
    'env:MCP_TEST_VALUE': 'balanced',
    'env:EXTRA_OPTION': '',
    'arg:1': 'auto',
  });
  const beforeManifestEdit = installs;
  const edited = await manager.configure('test-account', manifestEntry.id, {
    expected_revision: manifestEntry.config_revision,
    env: { CUSTOM_ENV: 'kept' },
    manifest_values: { 'env:MCP_TEST_VALUE': 'relaxed', 'arg:1': 'manual' },
  });
  assert.equal(edited.error, undefined);
  assert.notEqual(edited.config_revision, manifestEntry.config_revision);
  const discovered = JSON.parse(edited.tools[0].description);
  assert.equal(discovered.value, 'relaxed');
  assert.deepEqual(discovered.args, ['--policy', 'manual']);
  assert.equal(installs, beforeManifestEdit, 'manifest edits reuse the installed package');
  assert.deepEqual((await manager.settings('test-account', manifestEntry.id)).env, {
    CUSTOM_ENV: 'kept', MCP_TEST_VALUE: 'relaxed', EXTRA_OPTION: '',
  });
  assert.equal(
    (await manager.settings('test-account', manifestEntry.id)).manifest.values['arg:1'],
    'manual',
  );
  const sameSource = await manager.install('test-account', {
    name: 'A different title',
    source: 'pypi:fake-mcp==2.0.0',
    catalog_id: 9,
    reuse_existing: true,
  });
  assert.equal(sameSource.id, manifestEntry.id);
  assert.equal(installs, beforeManifestEdit, 'deduplication happens before version downloads');
  const pythonUpdated = await manager.update('test-account', manifestEntry.id, undefined, '2.0.0');
  assert.equal(pythonUpdated.id, manifestEntry.id);
  assert.equal(pythonUpdated.installed_version, '2.0.0');
  assert.equal(pythonUpdated.source_key, manifestEntry.source_key);
  assert.deepEqual(JSON.parse(pythonUpdated.tools[0].description).args, ['--policy', 'manual']);
  await manager.update('test-account', manifestEntry.id, undefined, '2.0.0');
  assert.equal(installs, beforeManifestEdit + 1, 'already installed version is not fetched again');
  const second = await manager.install('test-account', {
    package: packageManifest, catalog_id: 9,
  });
  assert.notEqual(second.id, manifestEntry.id, 'explicitly adding another configuration is supported');
  assert.equal(second.catalog_id, 9);
  await manager.remove('test-account', second.id);
  await manager.remove('test-account', manifestEntry.id);

  const npmEntry = await manager.install('test-account', {
    source: 'npx -y @example/fixture@1.0.0 --policy balanced',
    env: { MCP_TEST_VALUE: 'keep' },
  });
  assert.equal(npmEntry.installed_version, '1.0.0');
  const npmUpdated = await manager.update('test-account', npmEntry.id, undefined, '2.0.0');
  assert.equal(npmUpdated.installed_version, '2.0.0');
  assert.equal(npmUpdated.id, npmEntry.id);
  assert.equal(npmUpdated.source_key, npmEntry.source_key);
  assert.deepEqual(JSON.parse(npmUpdated.tools[0].description).args, ['--policy', 'balanced']);
  assert.equal(JSON.parse(npmUpdated.tools[0].description).value, 'keep');
  const npmFailed = await manager.update('test-account', npmEntry.id, undefined, '3.0.0');
  assert.equal(npmFailed.installed_version, '2.0.0');
  assert.match(npmFailed.error, /Connection closed/);
  const afterNpmFailure = await manager.control('test-account', {
    local_id: npmEntry.id, action: 'call', tool: 'echo', arguments: { text: 'still running' },
  });
  assert.equal(afterNpmFailure.content[0].text, 'still running');
  await manager.remove('test-account', npmEntry.id);
  for (const directory of installedDirs) await assert.rejects(() => fs.access(directory), /ENOENT/);
  console.log(
    'PASS: Python and Git MCP parsing, manifest settings, discovery, restart, update rollback and cleanup',
  );
} finally {
  await manager.closeAll();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('chatter-mcp-python-test-'));
  await fs.rm(root, { recursive: true, force: true });
}
