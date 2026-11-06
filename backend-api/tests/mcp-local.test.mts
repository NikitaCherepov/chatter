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
    "if(m.method==='tools/list')return send(m.id,{tools:[{name:'echo',description:'Local echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},{name:'wait',inputSchema:{type:'object',properties:{}}},{name:'progress',inputSchema:{type:'object',properties:{}}}]});",
    "if(m.method==='resources/list')return send(m.id,{resources:[{name:'guide',uri:'fixture://guide'}]});",
    "if(m.method==='resources/templates/list')return send(m.id,{resourceTemplates:[]});",
    "if(m.method==='resources/read')return send(m.id,{contents:[{uri:m.params.uri,text:'LOCAL RESOURCE'}]});",
    "if(m.method==='tools/call'){",
    "if(m.params.name==='wait')return;",
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
        void manager
          .control(scope, { ...msg.payload, request_id: msg.request_id }, () =>
            wsClient.pendingIpc.get(msg.request_id)?.progress?.(++sequence),
          )
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
    assert.equal(catalog.items[0].package.identifier, '@example/local');
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
  assert.equal(tools.getMcpDefinitions(81).length, 0, 'new socket cannot reuse previous metadata');
  syncDesktopMcp(replacement, [installed]);
  local.dropLocalConnections(wsClient);
  assert.ok(tools.getMcpDefinitions(81).length, 'closing superseded socket preserves new metadata');
  wsClients.set(81, wsClient);
  syncDesktopMcp(wsClient, [installed]);
  row = store.connections(81).find((r: any) => r.local_id === installed.id);
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
  assert.equal(tools.getMcpDefinitions(81).length, 0, 'disabled local server unavailable');
  await manager.configure(scope, installed.id, { enabled: true });
  syncDesktopMcp(wsClient, await manager.list(scope));
  store.savePolicy({ allow_custom: false });
  assert.equal(
    tools.getMcpDefinitions(81).length,
    0,
    'administrator revocation applies to local MCP',
  );
  store.savePolicy({ allow_custom: true });
  local.dropLocalConnections(wsClient);
  wsClient.ws.readyState = 3;
  assert.equal(
    tools.getMcpDefinitions(81).length,
    0,
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
