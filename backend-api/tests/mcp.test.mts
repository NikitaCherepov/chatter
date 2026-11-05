import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dbPath = path.join(os.tmpdir(), 'chatter-mcp-' + process.pid + '-' + Date.now() + '.sqlite');
process.env.API_DB_PATH = dbPath;
process.env.ENCRYPTION_KEY = 'mcp-local-test-key';
process.env.MCP_CALLBACK_URL = 'https://chatter.example/backend/mcp/oauth/callback';
const { db } = require('../src/db.ts');
const store = require('../src/services/mcp/store.ts');
const network = require('../src/services/mcp/network.ts');
const tools = require('../src/services/mcp/tools.ts');
const client = require('../src/services/mcp/client.ts');
const { userMcpRouter, adminMcpRouter } = require('../src/services/mcp/routes.ts');
const express = require('express');
const dns = require('node:dns/promises');
const originalLookup = dns.lookup,
  originalFetch = network.mcpHttp.fetch;
const received: any[] = [];
let sessionNumber = 0;
let pendingResponse: any,
  invalidCatalog = false,
  samplingDenied = false;
let oauthUrl: URL | undefined,
  pkceVerifier = '';
const echo = {
  name: 'echo',
  description: 'Echo supplied text',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};
const wait = {
  name: 'wait',
  description: 'Wait for cancellation',
  inputSchema: { type: 'object', properties: {} },
};
const sampling = {
  name: 'sampling',
  description: 'Check unsupported reverse requests',
  inputSchema: { type: 'object', properties: {} },
};
const progressTool = {
  name: 'progress',
  description: 'Slow work with progress',
  inputSchema: { type: 'object', properties: {} },
};
let sampleResponse: any;
const fake = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  received.push({
    body,
    authorization: req.headers.authorization,
    session: req.headers['mcp-session-id'],
  });
  const reply = (result: any) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  if (body.method === 'initialize')
    res.setHeader('Mcp-Session-Id', 'test-session-' + ++sessionNumber);
  if (body.method === 'initialize')
    return reply({
      protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'test', version: '1' },
    });
  if (body.method === 'notifications/initialized') {
    res.writeHead(202).end();
    return;
  }
  if (body.method === 'tools/list')
    return reply({
      tools: invalidCatalog
        ? [
            {
              ...echo,
              inputSchema: {
                type: 'object',
                properties: { bad: { $ref: 'https://private/schema' } },
              },
            },
          ]
        : [echo, wait, sampling, progressTool],
    });
  if (body.method === 'tools/call') {
    if (body.params.name === 'wait') {
      pendingResponse = res;
      return;
    }
    if (body.params.name === 'progress') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let count = 0;
      const timer = setInterval(() => {
        count++;
        res.write(
          'event: message\ndata: ' +
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken: body.params._meta.progressToken, progress: count, total: 6 },
            }) +
            '\n\n',
        );
        if (count === 6) {
          clearInterval(timer);
          res.end(
            'event: message\ndata: ' +
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { content: [{ type: 'text', text: 'slow operation completed' }] },
              }) +
              '\n\n',
          );
        }
      }, 50);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (body.params.name === 'sampling') {
      sampleResponse = { res, id: body.id };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: message\ndata: ' +
          JSON.stringify({
            jsonrpc: '2.0',
            id: 9001,
            method: 'sampling/createMessage',
            params: { messages: [], maxTokens: 10 },
          }) +
          '\n\n',
      );
      return;
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify(body.params.arguments) }] });
  }
  if (body.id === 9001 && body.error) {
    samplingDenied = body.error.code === -32601;
    res.writeHead(202).end();
    sampleResponse.res.end(
      'event: message\ndata: ' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: sampleResponse.id,
          result: { content: [{ type: 'text', text: 'sampling denied' }] },
        }) +
        '\n\n',
    );
    return;
  }
  res.writeHead(202).end();
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const port = (fake.address() as any).port;
network.mcpHttp.fetch = async (input: any, init: any) => {
  const url = new URL(String(input)),
    headers = new Headers(init?.headers);
  const json = (body: any, status = 200, extra: any = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...extra },
    });
  if (url.hostname === 'auth.example') {
    if (url.pathname.includes('.well-known'))
      return json({
        issuer: 'https://auth.example',
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register')
      return json({ ...JSON.parse(String(init.body)), client_id: 'test-chatter-client' });
    if (url.pathname === '/token') {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('code'), 'test-authorization-code');
      assert.equal(
        params.get('code_verifier'),
        pkceVerifier,
        'callback uses the saved PKCE verifier',
      );
      return json({
        access_token: 'oauth-private-token',
        refresh_token: 'oauth-private-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
  }
  if (url.hostname === 'oauth-mcp.example') {
    if (url.pathname.includes('.well-known'))
      return json({
        resource: 'https://oauth-mcp.example/mcp',
        authorization_servers: ['https://auth.example'],
      });
    if (headers.get('Authorization') !== 'Bearer oauth-private-token')
      return json({}, 401, {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://oauth-mcp.example/.well-known/oauth-protected-resource"',
      });
  }
  return fetch('http://127.0.0.1:' + port + '/mcp', init);
};
dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const app = express();
app.use(express.json());
app.use(
  '/user/:userId/mcp',
  (req: any, _res: any, next: any) => {
    req.testUser = Number(req.params.userId);
    next();
  },
  userMcpRouter((req: any) => req.testUser),
);
app.use('/admin', adminMcpRouter());
const api = http.createServer(app);
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiBase = 'http://127.0.0.1:' + (api.address() as any).port;
const request = async (route: string, method = 'GET', body?: any) => {
  const response = await fetch(apiBase + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const waitFor = async (test: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('test condition timeout');
};
try {
  db.prepare(
    "INSERT INTO users(id,name,status) VALUES(81,'one','approved'),(82,'two','approved')",
  ).run();
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fc00::1',
    '::ffff:192.168.1.1',
  ])
    assert.equal(network.publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '2606:4700:4700::1111'])
    assert.equal(network.publicAddress(address), true, address);
  for (const url of [
    'http://example.com/mcp',
    'https://127.1/mcp',
    'https://2130706433',
    'https://[::1]',
    'https://user:pass@example.com',
    'https://localhost',
  ])
    assert.throws(() => network.mcpUrl(url));
  dns.lookup = async () => [{ address: '10.0.0.1', family: 4 }];
  await assert.rejects(
    () => network.resolveMcpAddress(new URL('https://example.com')),
    /private_address/,
  );
  dns.lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(
    () => network.resolveMcpAddress(new URL('https://example.com')),
    /private_address/,
  );
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const blocked = await request('/user/81/mcp/connections', 'POST', {
    name: 'custom',
    url: 'https://mcp.example/mcp',
  });
  assert.equal(blocked.status, 403);
  const serverResult = await request('/admin/servers', 'POST', {
    name: 'Test MCP',
    url: 'https://mcp.example/mcp',
    allowed: true,
    recommended: true,
    description: 'test',
  });
  assert.equal(serverResult.status, 201);
  const server = serverResult.body.server;
  const created = await request('/user/81/mcp/connections', 'POST', {
    server_id: server.id,
    name: 'mine',
    token: 'private-test-token',
    mode: 'search',
  });
  assert.equal(created.status, 201);
  const connection = created.body.connection;
  assert.equal(
    JSON.stringify(created.body).includes('private-test-token'),
    false,
    'API never returns credentials',
  );
  assert.equal(
    store.connections(81)[0].credentials.includes('private-test-token'),
    false,
    'database encrypts secrets',
  );
  assert.equal(
    (await request('/user/82/mcp/connections/' + connection.id, 'PATCH', { name: 'stolen' }))
      .status,
    404,
  );
  assert.equal(
    (await request('/user/81/mcp/connections/' + connection.id + '/refresh', 'POST')).status,
    200,
  );
  assert.deepEqual(
    store.publicConnection(store.connections(81)[0]).tools.map((t: any) => t.name),
    ['echo', 'wait', 'sampling', 'progress'],
  );
  assert.ok(
    received.every((item) => item.authorization === 'Bearer private-test-token'),
    'credentials only forwarded through the MCP connection',
  );
  const staleSecretRow = store.connections(81)[0];
  store.saveConnection(81, { token: 'new-secret' }, connection.id);
  assert.throws(
    () => store.saveCredentials(staleSecretRow, { tokens: { access_token: 'stale' } }),
    /connection_changed/,
  );
  store.saveConnection(81, { token: 'private-test-token' }, connection.id);
  const defs = tools.getMcpDefinitions(81);
  assert.ok(defs.some((d: any) => d.function.name === 'search_mcp_tools'));
  assert.ok(
    !defs.some((d: any) => d.function.name.startsWith('mcp_')),
    'search mode keeps schemas out of initial context',
  );
  const definitionsBeforeSearch = JSON.stringify(defs);
  const search = await tools.runMcpTool(81, 'search_mcp_tools', { query: 'echo' });
  assert.match(search, /Echo supplied/);
  assert.match(search, /inputSchema/);
  assert.match(search, /call_mcp_tool/);
  assert.ok(
    !search.includes('function_name'),
    'search does not advertise nonexistent native functions',
  );
  assert.equal(
    JSON.stringify(tools.getMcpDefinitions(81)),
    definitionsBeforeSearch,
    'search leaves the function-tool prefix unchanged',
  );
  await tools.runMcpTool(81, 'search_mcp_tools', { query: 'wait' });
  assert.equal(
    JSON.stringify(tools.getMcpDefinitions(81)),
    definitionsBeforeSearch,
    'different searches do not rebuild the prefix',
  );
  const named = {
    function: { name: tools.toolCatalog(81).find((item: any) => item.tool.name === 'echo').name },
  };
  const intervals: any[] = [];
  const originalInterval = globalThis.setInterval;
  let ai: any;
  try {
    globalThis.setInterval = ((...args: any[]) => {
      const timer = (originalInterval as any)(...args);
      intervals.push(timer);
      return timer;
    }) as any;
    ai = require('../src/services/ai.ts');
  } finally {
    globalThis.setInterval = originalInterval;
    for (const timer of intervals) clearInterval(timer);
  }
  const user = require('../src/services/chats.ts').getUserById(81);
  const noModel = async () => {
    throw new Error('MCP must reuse tools without invoking another model');
  };
  const existingSearch = await ai.runTool(
    user,
    0,
    'search_mcp_tools',
    JSON.stringify({ query: 'echo' }),
    noModel,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { availableToolDefs: defs },
  );
  assert.match(existingSearch, /Echo supplied/);
  assert.equal(
    JSON.stringify(defs),
    definitionsBeforeSearch,
    'the existing runner does not mutate available tool definitions',
  );
  const runnerResult = await ai.runTool(
    user,
    0,
    'call_mcp_tool',
    JSON.stringify({
      connection_id: connection.id,
      tool: 'echo',
      arguments: { text: 'existing runner' },
    }),
    noModel,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { availableToolDefs: defs },
  );
  assert.match(runnerResult, /existing runner/);
  const deniedRunner = await ai.runTool(
    user,
    0,
    named.function.name,
    JSON.stringify({ text: 'deny' }),
    noModel,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { availableToolDefs: [] },
  );
  assert.match(deniedRunner, /not allowed/);
  assert.ok(ai.getTaskAllowedToolNames().includes('search_mcp_tools'));
  assert.ok(ai.getTaskAllowedToolNames().includes('call_mcp_tool'));
  await assert.rejects(
    () =>
      tools.runMcpTool(81, 'call_mcp_tool', {
        connection_id: connection.id,
        tool: 'echo',
        arguments: { text: 123 },
      }),
    /invalid_arguments/,
  );
  const result = await tools.runMcpTool(81, 'call_mcp_tool', {
    connection_id: connection.id,
    tool: 'echo',
    arguments: { text: 'Hello' },
  });
  assert.match(result, /Hello/);
  const echoSessions = received
    .filter((item) => item.body.method === 'tools/call' && item.body.params.name === 'echo')
    .map((item) => item.session);
  assert.ok(echoSessions.length >= 2 && echoSessions[0]);
  assert.equal(
    new Set(echoSessions).size,
    1,
    'sequential tools retain their MCP session and server-side state',
  );

  await assert.rejects(
    () => tools.runMcpTool(82, named.function.name, { text: 'bad' }),
    /not_allowed/,
  );

  db.prepare('UPDATE mcp_connections SET timeout_seconds=? WHERE id=?').run(0.15, connection.id);
  let progressCount = 0;
  const started = Date.now();
  const slow = await client.callRemoteTool(
    81,
    connection.id,
    'progress',
    {},
    undefined,
    () => progressCount++,
  );
  assert.match(JSON.stringify(slow), /slow operation completed/);
  assert.ok(
    progressCount >= 1 && Date.now() - started >= 250,
    'progress extends the 150ms wait past the total duration',
  );
  db.prepare('UPDATE mcp_connections SET timeout_seconds=? WHERE id=?').run(300, connection.id);
  const waitPromise = tools
    .runMcpTool(81, 'call_mcp_tool', { connection_id: connection.id, tool: 'wait', arguments: {} })
    .catch((error: any) => error);
  await waitFor(() => !!pendingResponse);
  assert.equal(
    (await request('/user/81/mcp/connections/' + connection.id + '/cancel', 'POST')).body.cancelled,
    true,
  );
  assert.match(String(await waitPromise), /mcp_cancelled/);
  assert.equal(client.activeCalls.size, 0);
  pendingResponse.destroy();
  pendingResponse = null;

  await tools.runMcpTool(81, 'call_mcp_tool', {
    connection_id: connection.id,
    tool: 'sampling',
    arguments: {},
  });
  assert.equal(samplingDenied, true, 'sampling is not available to remote servers');

  await request('/user/81/mcp/connections/' + connection.id, 'PATCH', { selected_tools: [] });
  await assert.rejects(
    () => tools.runMcpTool(81, named.function.name, { text: 'blocked' }),
    /not_allowed/,
  );
  await request('/user/81/mcp/connections/' + connection.id, 'PATCH', {
    selected_tools: null,
    mode: 'eager',
  });
  assert.ok(tools.getMcpDefinitions(81).some((d: any) => d.function.name === named.function.name));

  invalidCatalog = true;
  assert.equal(
    (await request('/user/81/mcp/connections/' + connection.id + '/refresh', 'POST')).status,
    400,
    'external schema references are rejected',
  );
  invalidCatalog = false;
  await request('/admin/servers/' + server.id, 'PATCH', {
    ...server,
    url: 'https://different.example/mcp',
    allowed: true,
    recommended: true,
  });
  assert.throws(
    () => store.requireConnection(81, connection.id),
    /not_allowed/,
    'editing an approved endpoint cannot redirect user credentials',
  );
  const changedEndpoint = await request('/user/81/mcp/connections', 'POST', {
    server_id: server.id,
    url: server.url,
    name: 'stale form',
    token: 'must-not-be-redirected',
  });
  assert.equal(
    changedEndpoint.body.error,
    'mcp_server_changed',
    'new connection also binds a user-entered token to the endpoint they selected',
  );
  await request('/admin/users/82', 'PUT', { override: 'allow' });
  assert.equal(store.policy(82).allow_custom, true);
  assert.equal(store.policy(81).allow_custom, false);
  assert.equal(
    (
      await request('/user/82/mcp/connections', 'POST', {
        name: 'custom',
        url: 'https://other.example/mcp',
      })
    ).status,
    201,
  );
  await request('/admin/policy', 'PUT', { enabled: false, allow_custom: false });
  assert.equal(tools.getMcpDefinitions(82).length, 0, 'global disable wins over user override');
  await request('/admin/policy', 'PUT', { enabled: true, allow_custom: false });
  const oauthConnection = store.saveConnection(82, {
    name: 'OAuth MCP',
    url: 'https://oauth-mcp.example/mcp',
  });
  const authorization = await client.beginOAuth(82, oauthConnection.id);
  oauthUrl = new URL(authorization.authorization_url);
  assert.equal(oauthUrl.origin, 'https://auth.example');
  assert.equal(oauthUrl.searchParams.get('code_challenge_method'), 'S256');
  const state = oauthUrl.searchParams.get('state')!;
  assert.ok(state);
  pkceVerifier = store.credentials(
    store.connections(82).find((c: any) => c.id === oauthConnection.id),
  ).verifier;
  assert.ok(pkceVerifier);
  await assert.rejects(
    () => client.finishOAuth('wrong-state', 'test-authorization-code'),
    /invalid_oauth_state/,
  );
  await client.finishOAuth(state, 'test-authorization-code');
  const oauthRow = store.connections(82).find((c: any) => c.id === oauthConnection.id);
  assert.equal(store.credentials(oauthRow).tokens.access_token, 'oauth-private-token');
  assert.equal(
    JSON.stringify(store.publicConnection(oauthRow)).includes('oauth-private-token'),
    false,
  );
  await assert.rejects(
    () => client.finishOAuth(state, 'test-authorization-code'),
    /invalid_oauth_state/,
    'OAuth callback is single-use',
  );
  console.log(
    'PASS: OAuth discovery, dynamic registration, PKCE, encrypted tokens and single-use account-bound callback',
  );
  store.savePolicy({ override: 'allow' }, 81);
  store.savePolicy({ override: 'deny' }, 82);
  db.prepare(
    'INSERT INTO mcp_oauth_states(state_hash,user_id,connection_id,expires_at) VALUES(?,?,?,?)',
  ).run('merge-state', 81, connection.id, Date.now() + 10000);
  require('../src/services/accounts.ts').mergeAccounts(81, 82, 'mcp-test');
  const moved = store.connections(82).find((c: any) => c.id === connection.id);
  assert.ok(moved, 'MCP connections survive account merging');
  assert.equal(store.credentials(moved).bearer, 'private-test-token');
  assert.equal(store.policy(82).override, 'deny', 'merge does not widen administrator permissions');
  assert.equal(
    db.prepare('SELECT * FROM mcp_oauth_states WHERE state_hash=?').get('merge-state'),
    undefined,
  );
  console.log(
    'PASS: actual MCP SDK HTTP initialization/discovery/calls, schemas, search/eager modes, encrypted per-user credentials, SSRF checks, policy, revocation, cancellation and sampling rejection',
  );
} finally {
  network.mcpHttp.fetch = originalFetch;
  dns.lookup = originalLookup;
  for (const call of client.activeCalls.values()) call.controller.abort();
  await client.closeMcpSessions();
  api.closeAllConnections();
  fake.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => api.close(() => r())),
    new Promise<void>((r) => fake.close(() => r())),
  ]);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}
