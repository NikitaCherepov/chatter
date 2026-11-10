import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatter-local-mcp-'));
process.env.API_DB_PATH = path.join(root, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'local-test';
const { db } = require('../src/db.ts');
const { LocalMcpManager } = require('../../desktop-app/src/main/local-mcp.ts');
const spec = require('../../desktop-app/src/main/local-mcp-spec.ts');
const { wsClients } = require('../src/ws-clients.ts');
const store = require('../src/services/mcp/store.ts');
const local = require('../src/services/mcp/local.ts');
const { syncDesktopMcp } = require('../src/services/mcp/routes.ts');
const tools = require('../src/services/mcp/tools.ts');
const client = require('../src/services/mcp/client.ts');
const discovery = require('../src/services/mcp/discovery.ts');
const fixture = path.join(root, 'server.cjs');
await fs.writeFile(
  fixture,
  [
    "const readline=require('node:readline');let count=0;",
    "const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');",
    "readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);",
    "if(m.method==='initialize')return send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}});",
    "if(m.method==='tools/list')return send(m.id,{tools:[{name:'echo',description:'Local echo',inputSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{text:{type:'string'}},required:['text']}},{name:'wait',inputSchema:{type:'object',properties:{}}},{name:'progress',inputSchema:{type:'object',properties:{}}}]});",
    "if(m.method==='resources/list')return send(m.id,{resources:[{name:'guide',uri:'fixture://guide'}]});",
    "if(m.method==='resources/templates/list')return send(m.id,{resourceTemplates:[]});",
    "if(m.method==='resources/read')return send(m.id,{contents:[{uri:m.params.uri,text:'LOCAL RESOURCE'}]});",
    "if(m.method==='tools/call'){",
    "if(m.params.name==='wait')return;",
    "if(m.params.arguments?.text==='rpc-error'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'File path must be within BASE_DIR',data:{stack:'private-server-stack'}}})+'\\n');return;}",

    "if(m.params.name==='progress'){let n=0;const timer=setInterval(()=>{n++;process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:m.params._meta.progressToken,progress:n}})+'\\n');if(n===8){clearInterval(timer);send(m.id,{content:[{type:'text',text:'progress done'}]});}},50);return;}",
    "return send(m.id,{content:[{type:'text',text:m.params.arguments.text+':'+(++count)+':'+(process.env.PRIVATE_KEY==='secret-local')}]});}",
    '});',
  ].join('\n'),
);
const installations: string[] = [];
const manager = new LocalMcpManager(
  path.join(root, 'managed'),
  (text: string) => Buffer.from(text).map((b) => b ^ 42),
  (data: Buffer) => Buffer.from(data.map((b) => b ^ 42)).toString(),
  async (_runtime: string, dir: string, pkg: string) => {
    installations.push(pkg);
    await fs.writeFile(path.join(dir, 'installed-package'), 'owned');
    return {
      command: process.execPath,
      entry: fixture,
      version: '1',
      path: path.dirname(process.execPath),
    };
  },
);
const scope = 'https://test.example:81';
const sent: Array<{ type: string; payload?: any }> = [];
let sequence = 0;
const wsClient: any = {
  accountId: 81,
  lastPongAt: Date.now(),
  lastMessageAt: Date.now(),
  connectionId: 'test-current',
  pendingIpc: new Map(),
  ws: {
    readyState: 1,
    send: (text: string, callback?: () => void) => {
      const msg = JSON.parse(text);
      sent.push(msg);
      callback?.();
      if (msg.type === 'execute_ipc')
        void (msg.ipc_type === 'mcp_permission'
          ? manager.configure(scope,msg.payload.local_id,{approval_policy:msg.payload.approval_policy,expected_revision:msg.payload.config_revision})
          : manager.control(scope, { ...msg.payload, request_id: msg.request_id }, (phase: string) =>
            wsClient.pendingIpc.get(msg.request_id)?.progress?.(++sequence, phase),
          ))
          .then((value: any) => {
            const pending = wsClient.pendingIpc.get(msg.request_id);
            wsClient.pendingIpc.delete(msg.request_id);
            pending?.resolve(value);
          })
          .catch((error: any) => {
            const pending = wsClient.pendingIpc.get(msg.request_id);
            wsClient.pendingIpc.delete(msg.request_id);
            pending?.reject(error);
          });
      if (msg.type === 'cancel_ipc') void manager.cancel(msg.request_id);
    },
  },
};
const unwrap = (value: string) =>
  JSON.parse(value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1));
try {
  db.prepare(
    "INSERT INTO users(id,name,status) VALUES(81,'one','approved'),(82,'two','approved')",
  ).run();
  store.savePolicy({ enabled: true, allow_custom: true, show_catalog: true });
  wsClients.set(81, wsClient);
  const network = require('../src/services/mcp/network.ts'),
    originalFetch = network.mcpHttp.fetch;
  try {
    network.mcpHttp.fetch = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'io.example/local',
                version: '1.0.0',
                packages: [
                  {registryType:'pypi',identifier:'windows-mcp',version:'0.8.8',transport:{type:'stdio'}},
                  {
                    registryType: 'npm',
                    identifier: '@example/local',
                    version: '1.0.0',
                    transport: { type: 'stdio' },
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const catalog = await require('../src/services/mcp/catalog.ts').registryCatalog(
      'local-fixture',
    );
    assert.equal(catalog.items[0].transport, 'stdio');
    assert.ok(catalog.items.some((item:any)=>item.package?.identifier==='@example/local'));
    assert.ok(catalog.items.some((item:any)=>item.package?.registryType==='pypi'&&item.package.identifier==='windows-mcp'));
  } finally {
    network.mcpHttp.fetch = originalFetch;
  }
  assert.equal(
    spec.npmSpec('https://www.npmjs.com/package/@scope/server/v/1.2.3'),
    '@scope/server@1.2.3',
  );
  assert.deepEqual(spec.splitCommand('"C:\\Program Files\\node.exe" "C:\\folder\\server.js"'), [
    'C:\\Program Files\\node.exe',
    'C:\\folder\\server.js',
  ]);
  assert.throws(
    () => spec.resolveLocalInput({ source: 'node fake.js && echo bad' }),
    /direct_executable/,
  );
  const pkg = {
    registryType: 'npm',
    identifier: '@scope/server',
    version: '1.2.3',
    transport: { type: 'stdio' },
    environmentVariables: [{ name: 'PRIVATE_KEY', isRequired: true, isSecret: true }],
    packageArguments: [{ type: 'positional', valueHint: 'folder', isRequired: true }],
  };
  assert.throws(() => spec.resolveLocalInput({ package: pkg }), /required_configuration/);
  const noSecrets = new LocalMcpManager(
    path.join(root, 'no-secrets'),
    () => {
      throw new Error('no_crypto');
    },
    () => '',
    async () => {
      throw new Error('must_not_install');
    },
  );
  await assert.rejects(
    () =>
      noSecrets.install(scope, {
        source: JSON.stringify({ command: process.execPath, args: [fixture] }),
      }),
    /no_crypto/,
  );
  assert.equal(
    (await noSecrets.list(scope)).length,
    0,
    'failed secret storage leaves no broken install',
  );
  const installed = await manager.install(scope, {
    name: 'Local fixture',
    package: pkg,
    values: { 'env:PRIVATE_KEY': 'secret-local', 'arg:0': root },
  });
  assert.deepEqual(installed.approval_policy,{allow_all:false,tools:[],resources:[]});
  const {saveMcpApproval}=require('../src/services/mcp/approval-policy.ts');
  assert.deepEqual(installations, ['@scope/server@1.2.3']);
  assert.equal(installed.tools.length, 3);
  assert.equal(installed.resources.length, 1);
  assert.equal(installed.error, undefined);
  assert.equal(
    JSON.stringify(installed).includes('secret-local'),
    false,
    'public metadata omits configuration',
  );
  assert.equal(
    (await manager.list(scope + ':other')).length,
    0,
    'local installations isolated by account/server scope',
  );
  assert.throws(
    () => syncDesktopMcp({ ...wsClient, accountId: 82 }, [installed]),
    /connection_changed/,
  );
  assert.equal(syncDesktopMcp(wsClient, [installed]), 1);
  let row = store.connections(81).find((r: any) => r.local_id === installed.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM mcp_connections').get().n,
    0,
    'local metadata is RAM-only',
  );
  assert.ok(row);
  assert.equal(store.connections(82).length, 0);
  const replacement = { ...wsClient, connectionId: 'replacement' };
  wsClients.set(81, replacement);
  assert.ok(!tools.getMcpDefinitions(81).some((item: any) => item.function.name === 'call_mcp_tool'),
    'new socket cannot reuse previous metadata');
  syncDesktopMcp(replacement, [installed]);
  local.dropLocalConnections(wsClient);
  assert.ok(tools.getMcpDefinitions(81).some((item: any) => item.function.name === 'call_mcp_tool'),
    'closing superseded socket preserves new metadata');
  wsClients.set(81, wsClient);
  syncDesktopMcp(wsClient, [installed]);
  row = store.connections(81).find((r: any) => r.local_id === installed.id);
  await saveMcpApproval(81,row.id,{allow_all:false,tools:['echo'],resources:[]});
  await Promise.all([
    manager.control(scope,{local_id:installed.id,action:'discover'}),
    manager.configure(scope,installed.id,{approval_policy:{allow_all:false,tools:['echo'],resources:[]}})
  ]);
  await assert.rejects(()=>manager.configure(scope,installed.id,{expected_revision:'stale',approval_policy:{allow_all:true,tools:[],resources:[]}}),/connection_changed/);
  const persisted=(await manager.list(scope))[0];
  assert.deepEqual(persisted.approval_policy.tools,['echo'],'remember permission persisted on PC');
  syncDesktopMcp(wsClient,[persisted]);
  assert.equal(JSON.parse(store.connections(81)[0].approval_policy_json).allow_all,false);
  await manager.configure(scope,installed.id,{approval_policy:{allow_all:true,tools:[],resources:[]}});
  Object.assign(installed,(await manager.list(scope))[0]);
  syncDesktopMcp(wsClient,[installed]);
  const prefix = JSON.stringify(tools.getMcpDefinitions(81));
  const browse = await tools.runMcpTool(81, 'browse_mcp', { connection_id: row.id });
  assert.match(browse, /Local echo/);
  const echoed = await tools.runMcpTool(81, 'call_mcp_tool', {
    connection_id: row.id,
    tool: 'echo',
    arguments: { text: 'telegram' },
  });
  assert.match(echoed, /telegram:1:true/, 'existing tool route reaches actual stdio process');
  assert.match(
    await tools.runMcpTool(81, 'call_mcp_tool', {
      connection_id: row.id,
      tool: 'echo',
      arguments: { text: 'second' },
    }),
    /second:2:true/,
    'process session is reused',
  );
  const failure=JSON.parse(await tools.runMcpTool(81,'call_mcp_tool',{
    connection_id:row.id,tool:'echo',arguments:{text:'rpc-error'},
  }));
  assert.equal(failure.status,'error');
  assert.match(failure.result,/File path must be within BASE_DIR/);
  assert.match(failure.result,/-32602/);
  assert.equal(failure.result.includes('private-server-stack'),false,'only the protocol message is returned, not arbitrary error data');
  assert.match(await tools.runMcpTool(81,'call_mcp_tool',{
    connection_id:row.id,tool:'echo',arguments:{text:'after-error'},
  }),/after-error:3:true/,'validation error keeps the stdio process alive');
  await assert.rejects(
    () =>
      tools.runMcpTool(82, 'call_mcp_tool', {
        connection_id: row.id,
        tool: 'echo',
        arguments: { text: 'stolen' },
      }),
    /not_allowed/,
  );
  await assert.rejects(
    () =>
      tools.runMcpTool(81, 'call_mcp_tool', {
        connection_id: row.id,
        tool: 'echo',
        arguments: { text: 2 },
      }),
    /invalid_arguments/,
  );
  assert.match(
    await discovery.readMcpResource(81, { connection_id: row.id, uri: 'fixture://guide' }),
    /LOCAL RESOURCE/,
  );
  assert.equal(
    JSON.stringify(tools.getMcpDefinitions(81)),
    prefix,
    'calls do not alter function definitions',
  );
  assert.ok(
    sent.some((msg) => msg.type === 'execute_ipc' && msg.payload.local_id === installed.id),
  );
  assert.equal(
    sent.some((msg) => JSON.stringify(msg).includes('secret-local')),
    false,
  );
  let reportedProgress = 0;
  row.timeout_seconds = 0.15;
  assert.match(
    await tools.runMcpTool(
      81,
      'call_mcp_tool',
      {
        connection_id: row.id,
        tool: 'progress',
        arguments: {},
      },
      undefined,
      () => reportedProgress++,
    ),
    /progress done/,
    'IPC progress extends local MCP idle timeout',
  );
  assert.ok(reportedProgress > 0, 'progress reaches the existing agent status callback');
  row.timeout_seconds = 300;
  const abort = new AbortController();
  const waiting = tools.runMcpTool(
    81,
    'call_mcp_tool',
    { connection_id: row.id, tool: 'wait', arguments: {} },
    abort.signal,
  );
  await new Promise((r) => setTimeout(r, 80));
  abort.abort();
  await assert.rejects(() => waiting);
  assert.ok(sent.some((msg) => msg.type === 'cancel_ipc'));
  await new Promise((r) => setTimeout(r, 100));
  await manager.configure(scope, installed.id, { enabled: false });
  syncDesktopMcp(wsClient, await manager.list(scope));
  const hasLocalCalls = () => tools.getMcpDefinitions(81).some((item: any) => item.function.name === 'call_mcp_tool');
  assert.equal(hasLocalCalls(), false, 'disabled local server unavailable');
  await manager.configure(scope, installed.id, { enabled: true });
  syncDesktopMcp(wsClient, await manager.list(scope));
  store.savePolicy({ allow_custom: false });
  assert.equal(
    hasLocalCalls(),
    false,
    'administrator revocation applies to local MCP',
  );
  store.savePolicy({ allow_custom: true });
  local.dropLocalConnections(wsClient);
  wsClient.ws.readyState = 3;
  assert.equal(
    hasLocalCalls(),
    false,
    'offline desktop has no callable local tools',
  );
  wsClient.ws.readyState = 1;
  syncDesktopMcp(wsClient, await manager.list(scope));
  assert.ok(tools.getMcpDefinitions(81).length);
  const outside = path.join(root, 'user-file');
  await fs.writeFile(outside, 'keep');
  await assert.rejects(() => manager.remove(scope, '../../outside'), /invalid_local_id/);
  await manager.remove(scope, installed.id);
  syncDesktopMcp(wsClient, await manager.list(scope));
  assert.equal((await manager.list(scope)).length, 0);
  assert.equal(store.connections(81).length, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  const { getPendingPcConfirmation, deletePendingPcConfirmation } = require('../src/services/pc-command-confirmations.ts');
  const plan = {
    name: 'MCP Install Fixture',
    documentation: 'https://github.com/example/fixture#installation',
    command: 'npx',
    args: ['-y', '@example/install-fixture'],
  };
  const prepareInstall = () => {
    const actions: any[] = [];
    const run = tools.runMcpTool(81, 'install_mcp', plan, undefined, undefined, undefined, {
      onDesktopAction: (action: any) => { actions.push(action); },
    });
    return { run, actions };
  };
  const approveInstall = async (request: ReturnType<typeof prepareInstall>) => {
    const action = request.actions.find((item) => item.action === 'mcp_confirmation');
    assert.equal(action.value.operation, 'install');
    const id = action.value.confirmation_id;
    const pending = getPendingPcConfirmation(id);
    assert.equal(deletePendingPcConfirmation(id), true);
    try { pending.resolve(await pending.execute({ remember: true })); }
    catch (error) { pending.reject(error); }
    return request.run;
  };
  const previousInstalls = installations.length;
  const revokedInstall = prepareInstall();
  assert.equal(installations.length, previousInstalls);
  store.savePolicy({ allow_custom: false });
  await assert.rejects(() => approveInstall(revokedInstall), /mcp_custom_not_allowed/);
  assert.equal(installations.length, previousInstalls);
  await assert.rejects(() => prepareInstall().run, /mcp_custom_not_allowed/);
  store.savePolicy({ allow_custom: true });
  const request = prepareInstall();
  assert.equal(installations.length, previousInstalls, 'install waits for explicit approval');
  const result = JSON.parse(await approveInstall(request));
  assert.equal(result.status, 'connected');
  assert.equal(result.tools, 3);
  assert.deepEqual(request.actions.filter((action) => action.action === 'mcp_install_progress').map((action) => action.value.phase),
    ['installing', 'connecting']);
  assert.equal(installations.length, previousInstalls + 1);
  assert.deepEqual((await manager.list(scope))[0].approval_policy, spec.emptyMcpApproval());
  const repeated = JSON.parse(await approveInstall(prepareInstall()));
  assert.equal(repeated.status, 'already_connected');
  assert.equal(repeated.local_id, result.local_id);
  assert.equal(installations.length, previousInstalls + 1);
  await manager.configure(scope, result.local_id, {
    args: ['serve', '--token', 'private-argument'],
    env: { PRIVATE_KEY: 'private-environment', WINDOWS_MCP_CONTROL_POLICY: 'relaxed' },
  });
  const syncSettings = async () => syncDesktopMcp(wsClient, await manager.list(scope));
  await syncSettings();
  const configId = store.connections(81).find((item: any) => item.local_id === result.local_id).id;
  function requestConfiguration(input: any) {
    let confirmation: any;
    const response = tools.runMcpTool(81, 'configure_mcp', { connection_id: configId, ...input },
      undefined, undefined, undefined, {
        onDesktopAction: (action: any) => {
          if (action.action === 'mcp_confirmation') confirmation = action.value;
        },
      });
    const id = confirmation.confirmation_id;
    const pending = getPendingPcConfirmation(id);
    return {
      confirmation,
      approve: async () => {
        assert.equal(deletePendingPcConfirmation(id), true);
        try { pending.resolve(await pending.execute({ remember: true })); }
        catch (error) { pending.reject(error); }
        return response;
      },
    };
  }
  const beforeRead = sent.filter((item) => item.payload?.action === 'read_settings').length;
  const read = requestConfiguration({ action: 'read', looking_for: 'CONTROL_POLICY' });
  assert.equal(read.confirmation.operation, 'config_read');
  assert.equal(sent.filter((item) => item.payload?.action === 'read_settings').length, beforeRead);
  const filtered = unwrap(JSON.parse(await read.approve()).settings);
  assert.deepEqual(filtered, { env: { WINDOWS_MCP_CONTROL_POLICY: { set: true } } });
  const all = await requestConfiguration({ action: 'read' }).approve();
  assert.doesNotMatch(all, /private-argument|private-environment|relaxed/);
  assert.deepEqual(unwrap(JSON.parse(all).settings).args, ['serve', '[redacted]', '[redacted]']);
  const changes = { append_args: ['--no-control'], env: { WINDOWS_MCP_CONTROL_POLICY: 'balanced' } };
  const update = requestConfiguration({ action: 'update', patch: changes });
  assert.equal(update.confirmation.operation, 'config_update');
  assert.deepEqual(update.confirmation.arguments, changes);
  assert.equal(JSON.parse(await update.approve()).tool_count, 3);
  const settings = await manager.settings(scope, result.local_id);
  assert.deepEqual(settings.args, ['serve', '--token', 'private-argument', '--no-control']);
  assert.deepEqual(settings.env, { PRIVATE_KEY: 'private-environment', WINDOWS_MCP_CONTROL_POLICY: 'balanced' });
  await syncSettings();
  const stale = requestConfiguration({ action: 'update', patch: { env: { WINDOWS_MCP_CONTROL_POLICY: null } } });
  await manager.configure(scope, result.local_id, { timeout_seconds: 42 });
  // Simulate a manual edit whose new revision has not yet reached the backend.
  await assert.rejects(stale.approve, /mcp_connection_changed/);
  await syncSettings();
  await assert.rejects(requestConfiguration({ action: 'update', patch: { env: { PRIVATE_KEY: 'replace' } } }).approve,
    /mcp_configuration_field_not_allowed/);
  await requestConfiguration({ action: 'update', patch: { env: { WINDOWS_MCP_CONTROL_POLICY: null } } }).approve();
  assert.deepEqual((await manager.settings(scope, result.local_id)).env, { PRIVATE_KEY: 'private-environment' });
  console.log('PASS: bot config confirmation, filtering, secret redaction, patches, restart and stale revision');
  await manager.remove(scope, result.local_id);
  console.log('PASS: bot install confirmation, policy recheck, desktop install and progress, duplicate reuse');
  console.log(
    'PASS: actual stdio discovery/calls/resources, session reuse, local encrypted configuration, scope isolation, RAM-only WS bridge, progress, cancellation, permissions, offline and removal',
  );
  if (process.env.MCP_REAL_INSTALL === '1') {
    const keepAlive = setInterval(() => {}, 1000);
    const real = new LocalMcpManager(
      path.join(root, 'real'),
      (text: string) => Buffer.from(text),
      (data: Buffer) => data.toString(),
    );
    try {
      const entry = await real.install(scope, {
        source: '@modelcontextprotocol/server-memory@2.1.0',
      });
      assert.equal(entry.error, undefined, 'actual npm package starts');
      assert.ok(entry.tools.length > 0);
      const result = await real.control(scope, {
        action: 'call',
        local_id: entry.id,
        tool: 'read_graph',
        arguments: {},
      });
      assert.ok(result.content);
      await real.remove(scope, entry.id);
      console.log(
        'PASS: real portable Node download/checksum, npm installation and official server-memory stdio call/removal',
      );
    } finally {
      clearInterval(keepAlive);
      await real.closeAll();
    }
  }
} finally {
  for (const request of wsClient.pendingIpc.values()) request.reject(new Error('test_cleanup'));
  wsClients.clear();
  await manager.closeAll();
  await client.closeMcpSessions();
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('chatter-local-mcp-'));
  await fs.rm(root, { recursive: true, force: true });
}
