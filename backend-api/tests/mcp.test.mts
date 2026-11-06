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
delete process.env.MCP_CALLBACK_URL;
let expectedCallback = 'https://chatter.example/backend/mcp/oauth/callback';
const previousDb = new (require('better-sqlite3'))(dbPath);
previousDb.exec(
  'CREATE TABLE mcp_policy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,allow_custom INTEGER NOT NULL DEFAULT 0); INSERT INTO mcp_policy VALUES(1,1,0); CREATE TABLE mcp_user_policy(user_id INTEGER PRIMARY KEY,allow_custom INTEGER);',
);
previousDb.close();
const { db } = require('../src/db.ts');
const store = require('../src/services/mcp/store.ts');
const network = require('../src/services/mcp/network.ts');
const tools = require('../src/services/mcp/tools.ts');
const client = require('../src/services/mcp/client.ts');
const { userMcpRouter, adminMcpRouter, oauthCallback } = require('../src/services/mcp/routes.ts');
const express = require('express');
const dns = require('node:dns/promises');
const originalLookup = dns.lookup,
  originalFetch = network.mcpHttp.fetch;
const received: any[] = [];
const { wsClients } = require('../src/ws-clients.ts');
const notices: Array<{ userId: number; event: any }> = [];
for (const userId of [81, 82, 83])
  wsClients.set(userId, {
    ws: {
      readyState: userId === 83 ? 3 : 1,
      send: (payload: string) => notices.push({ userId, event: JSON.parse(payload) }),
    },
  });
let registryRequests = 0;

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
    $schema: 'https://json-schema.org/draft/2020-12/schema',
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
      capabilities:
        req.headers.authorization === 'Bearer resources-only'
          ? { resources: {} }
          : { tools: {}, resources: {} },
      serverInfo: { name: 'test', version: '1' },
    });
  if (body.method === 'notifications/initialized') {
    res.writeHead(202).end();
    return;
  }
  if (body.method === 'resources/list')
    return reply({
      resources: [
        {
          uri: 'notes://guide',
          name: 'guide',
          description: 'Project guide',
          mimeType: 'text/plain',
        },
      ],
    });
  if (body.method === 'resources/templates/list')
    return reply({
      resourceTemplates: [
        { uriTemplate: 'notes://project/{id}', name: 'project', description: 'Project notes' },
      ],
    });
  if (body.method === 'resources/read')
    return reply({
      contents: [
        {
          uri: body.params.uri,
          mimeType: 'text/plain',
          text: 'PRIVATE_RESOURCE_BODY: ' + body.params.uri,
        },
      ],
    });
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
  if (url.hostname === 'registry.modelcontextprotocol.io') {
    registryRequests++;
    assert.equal(url.searchParams.get('version'), 'latest');
    assert.equal(url.searchParams.get('search'), 'fixture');
    const server = {
      name: 'com.example/test',
      title: 'Test Server',
      description: 'Current',
      version: '2.0',
      repository: { url: 'https://github.com/example/test' },
      websiteUrl: 'javascript:bad()',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example/mcp' }],
    };
    return json({
      servers: [
        {
          server,
          _meta: {
            'io.modelcontextprotocol.registry/official': { isLatest: true, status: 'active' },
          },
        },
        { server },
        {
          server: { ...server, version: '1.0' },
          _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } },
        },
        {
          server: { ...server, name: 'com.example/deleted' },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } },
        },
        {
          server: {
            ...server,
            name: 'com.example/private',
            remotes: [{ type: 'streamable-http', url: 'https://127.0.0.1/mcp' }],
          },
        },
        {
          server: {
            ...server,
            name: 'com.example/stdio',
            remotes: [],
            packages: [{ registryType: 'npm' }],
          },
        },
      ],
      metadata: { nextCursor: url.searchParams.get('cursor') ? undefined : 'page2' },
    });
  }
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
      assert.equal(params.get('redirect_uri'), expectedCallback, 'token exchange uses the original callback');
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
app.get('/mcp/oauth/callback', oauthCallback);
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

  const notificationsBeforeInvalid = notices.length;
  const blocked = await request('/user/81/mcp/connections', 'POST', {
    name: 'custom',
    url: 'https://mcp.example/mcp',
  });
  assert.equal(blocked.status, 403);
  assert.equal(notices.length, notificationsBeforeInvalid, 'failed mutation sends no notification');
  const serverResult = await request('/admin/servers', 'POST', {
    name: 'Test MCP',
    url: 'https://mcp.example/mcp',
    allowed: true,
    recommended: true,
    description: 'test',
  });
  assert.equal(serverResult.status, 201);
  assert.deepEqual(
    notices.slice(-2).map((item) => item.userId),
    [81, 82],
    'admin server changes notify connected users',
  );
  assert.ok(notices.every((item) => item.event.type === 'mcp_settings_updated'));
  assert.ok(
    notices.every((item) => Object.keys(item.event).every(key=>['type','resync_local'].includes(key))),
    'notifications contain no metadata or secrets',
  );
  const localRecommendation = await request('/admin/servers', 'POST', {
    name: 'Local browser', transport: 'stdio', source: 'npx -y @playwright/mcp@latest',
    allowed: true, recommended: true,
  });
  assert.equal(localRecommendation.status, 201);
  assert.equal(localRecommendation.body.server.source, 'npx -y @playwright/mcp@latest');
  assert.equal(localRecommendation.body.server.recommended, 1);
  const localInCatalog = (await request('/user/81/mcp')).body.servers.find(item => item.id === localRecommendation.body.server.id);
  assert.equal(localInCatalog.transport, 'stdio');
  assert.equal((await request('/user/81/mcp/connections', 'POST', {
    server_id: localRecommendation.body.server.id, name: 'Invalid remote',
  })).status, 403);
  await request('/admin/servers/' + localRecommendation.body.server.id, 'DELETE');
  const beforePersonalChange = notices.length;
  const server = serverResult.body.server;
  const created = await request('/user/81/mcp/connections', 'POST', {
    server_id: server.id,
    name: 'mine',
    token: 'private-test-token',
    mode: 'search',
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    notices.slice(beforePersonalChange).map((item) => item.userId),
    [81],
    'personal connection changes notify only owner',
  );
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
  store.saveConnection(81, {approval_policy:{allow_all:true,tools:[],resources:[]}}, connection.id);
  const staleSecretRow = store.connections(81)[0];
  store.saveConnection(81, { token: 'new-secret' }, connection.id);
  assert.throws(
    () => store.saveCredentials(staleSecretRow, { tokens: { access_token: 'stale' } }),
    /connection_changed/,
  );
  store.saveConnection(81, { token: 'private-test-token' }, connection.id);
  const defs = tools.getMcpDefinitions(81);
  assert.ok(defs.some((d: any) => d.function.name === 'browse_mcp'));
  assert.ok(
    !defs.some((d: any) => d.function.name.startsWith('mcp_')),
    'search mode keeps schemas out of initial context',
  );
  assert.ok(defs.some((d: any) => d.function.name === 'read_mcp_resource'));
  assert.ok(!defs.some((d: any) => d.function.name === 'search_mcp_tools'));
  assert.ok(
    tools.getMcpDefinitions(81, true).some((d: any) => d.function.name === 'search_mcp_tools'),
  );
  const definitionsBeforeSearch = JSON.stringify(defs);
  const search = await tools.runMcpTool(81, 'browse_mcp', { query: 'echo' });
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
  await tools.runMcpTool(81, 'browse_mcp', { query: 'wait' });
  assert.equal(
    JSON.stringify(tools.getMcpDefinitions(81)),
    definitionsBeforeSearch,
    'different searches do not rebuild the prefix',
  );
  const discovery = require('../src/services/mcp/discovery.ts');
  const unwrap = (value: string) =>
    JSON.parse(value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1));
  assert.equal(
    received.filter((x) => x.body.method === 'resources/read').length,
    0,
    'discovery never reads content',
  );
  const servers = unwrap(await discovery.browseMcp(81, {}));
  assert.equal(servers.items[0].resource_count, 1);
  assert.equal(servers.items[0].capabilities.resources, true);
  const first = unwrap(
    await discovery.browseMcp(81, { connection_id: connection.id, kind: 'resources', limit: 1 }),
  );
  assert.equal(first.items[0].uri, 'notes://guide');
  assert.equal(first.total, 2);
  assert.ok(first.next_cursor);
  const second = unwrap(
    await discovery.browseMcp(81, {
      connection_id: connection.id,
      kind: 'resources',
      limit: 1,
      cursor: first.next_cursor,
    }),
  );
  assert.equal(second.items[0].uriTemplate, 'notes://project/{id}');
  assert.equal(second.next_cursor, null);
  await assert.rejects(
    () => discovery.browseMcp(81, { kind: 'tools', cursor: first.next_cursor }),
    /cursor_stale/,
  );
  await assert.rejects(
    () => discovery.browseMcp(82, { kind: 'resources', cursor: first.next_cursor }),
    /cursor_stale/,
  );
  assert.equal(JSON.stringify(first).includes('PRIVATE_RESOURCE_BODY'), false);
  const readFirst = JSON.parse(
    await discovery.readMcpResource(81, {
      connection_id: connection.id,
      uri: 'notes://guide',
      max_chars: 7,
    }),
  );
  const readPage = unwrap(readFirst.result);
  assert.equal(readPage.contents[0].text, 'PRIVATE');
  assert.equal(readPage.next_offset, 7);
  const readRest = unwrap(
    JSON.parse(
      await discovery.readMcpResource(81, {
        connection_id: connection.id,
        uri: 'notes://guide',
        offset: 7,
      }),
    ).result,
  );
  assert.equal(
    readPage.contents[0].text + readRest.contents[0].text,
    'PRIVATE_RESOURCE_BODY: notes://guide',
  );
  assert.equal(readRest.next_offset, null);
  assert.match(
    await discovery.readMcpResource(81, {
      connection_id: connection.id,
      uri: 'notes://project/42',
    }),
    /project/,
  );
  const readCount = received.filter((x) => x.body.method === 'resources/read').length;
  await assert.rejects(
    () =>
      discovery.readMcpResource(81, { connection_id: connection.id, uri: 'file:///etc/passwd' }),
    /resource_not_allowed/,
  );
  await assert.rejects(
    () => discovery.readMcpResource(82, { connection_id: connection.id, uri: 'notes://guide' }),
    /connection_not_found/,
  );
  assert.equal(received.filter((x) => x.body.method === 'resources/read').length, readCount);
  assert.equal(
    JSON.stringify(tools.getMcpDefinitions(81)),
    definitionsBeforeSearch,
    'resource reads preserve tools prefix',
  );
  store.saveConnection(81, { selected_tools: ['echo'] }, connection.id);
  assert.equal(unwrap(await discovery.browseMcp(81, { kind: 'tools' })).total, 1);
  store.saveConnection(81, { selected_tools: null }, connection.id);
  const resourceOnly = store.saveConnection(81, {
    server_id: server.id,
    name: 'resources',
    token: 'resources-only',
  });
  const listToolsCount = received.filter((x) => x.body.method === 'tools/list').length;
  await client.refreshTools(81, resourceOnly.id);
  assert.equal(
    received.filter((x) => x.body.method === 'tools/list').length,
    listToolsCount,
    'resource-only servers do not require tools/list',
  );
  assert.equal(
    store.publicConnection(store.requireConnection(81, resourceOnly.id)).resources.length,
    1,
  );
  await discovery.readMcpResource(81, { connection_id: resourceOnly.id, uri: 'notes://guide' });
  store.deleteConnection(81, resourceOnly.id);
  const unapproved = await request('/admin/servers', 'POST', {
    name: 'Not approved',
    url: 'https://unapproved.example/mcp',
    allowed: false,
  });
  assert.equal(unapproved.status, 201, 'manual admin add needs no recommendation flag');
  const requestsBefore = registryRequests;
  const approved = (await request('/user/81/mcp/catalog')).body.items;
  assert.deepEqual(
    approved.map((item: any) => item.id),
    [server.id],
  );
  assert.equal((await request('/user/81/mcp/catalog?search=TEST%20MCP')).body.items.length, 1);
  assert.equal((await request('/user/81/mcp/catalog?search=unapproved')).body.items.length, 0);
  assert.equal(registryRequests, requestsBefore, 'desktop catalog never fetches public Registry');
  const catalog = require('../src/services/mcp/catalog.ts');
  const publicPage = await catalog.registryCatalog('fixture');
  assert.equal(publicPage.items.length, 1);
  assert.equal(publicPage.items[0].version, '2.0');
  assert.equal(publicPage.items[0].repository_url, 'https://github.com/example/test');
  assert.equal(publicPage.items[0].website_url, undefined);
  assert.match(publicPage.items[0].registry_url, /versions\/2.0/);
  await catalog.registryCatalog('fixture', publicPage.next_cursor);
  assert.equal(registryRequests, 2);
  await request('/admin/users/81', 'PUT', { override: 'allow' });
  const personalRegistry = await request('/user/81/mcp/catalog?search=fixture');
  assert.equal(personalRegistry.status, 200);
  assert.equal(
    personalRegistry.body.items[0].name,
    'com.example/test',
    'custom permission enables public Registry',
  );
  const customFromRegistry = await request('/user/81/mcp/connections', 'POST', {
    name: 'Registry server',
    url: personalRegistry.body.items[0].url,
  });
  assert.equal(customFromRegistry.status, 201, 'Registry entries connect as custom URLs');
  await request('/user/81/mcp/connections/' + customFromRegistry.body.connection.id, 'DELETE');
  await request('/admin/users/81', 'PUT', { override: 'inherit' });
  const restrictedCatalog = await request('/user/81/mcp/catalog?search=fixture');
  assert.equal(restrictedCatalog.body.items.length, 0, 'revocation switches back to approved list');
  assert.equal(
    (
      await request('/user/81/mcp/connections', 'POST', {
        name: 'Denied',
        url: 'https://unapproved.example/mcp',
      })
    ).status,
    403,
  );
  await assert.rejects(() => catalog.registryCatalog('ab'), /invalid_catalog_query/);
  await request('/admin/policy', 'PUT', {
    enabled: true,
    allow_custom: false,
    show_catalog: false,
  });
  assert.equal((await request('/user/81/mcp')).body.servers.length, 0);
  assert.equal((await request('/user/81/mcp/catalog?search=fixture')).status, 403);
  assert.equal(registryRequests, 2, 'hidden catalog does not contact Registry');
  assert.equal(
    (await request('/user/81/mcp/connections', 'POST', { server_id: server.id, name: 'hidden' }))
      .status,
    403,
  );
  assert.ok(store.requireConnection(81, connection.id), 'existing connections remain usable');
  const beforeOverride = notices.length;
  await request('/admin/users/81', 'PUT', { catalog_override: 'allow' });
  assert.deepEqual(
    notices.slice(beforeOverride).map((item) => item.userId),
    [81],
    'personal admin policy notification targets only owner',
  );
  assert.equal(store.policy(81).show_catalog, true);
  assert.equal(
    store.policy(81).allow_custom,
    false,
    'catalog permission does not alter custom URL permission',
  );
  await request('/admin/users/81', 'PUT', { override: 'allow' });
  assert.equal(
    store.policy(81).catalog_override,
    'allow',
    'partial policy updates preserve catalog override',
  );
  await request('/admin/policy', 'PUT', { enabled: true, allow_custom: false, show_catalog: true });
  await request('/admin/users/81', 'PUT', { catalog_override: 'deny', override: 'inherit' });
  assert.equal(
    (await request('/user/81/mcp')).body.servers.length,
    0,
    'personal hide overrides global show',
  );
  await request('/admin/users/81', 'PUT', { catalog_override: 'inherit' });
  console.log(
    'PASS: resource metadata/read/templates, pagination, resource-only servers, stable definitions, latest catalog and global/personal visibility',
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
    'browse_mcp',
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
  assert.ok(ai.getTaskAllowedToolNames().includes('browse_mcp'));
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

  await (await import('./mcp-approvals.fixture.mjs')).checkApprovals({tools, store, connection, received, require});
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
  const previousAccess = (await request('/admin/access')).body.access;
  assert.equal(previousAccess.allow_custom.mode, 'selected');
  assert.deepEqual(previousAccess.allow_custom.user_ids, [82]);
  let accessResult = await request('/admin/access', 'PUT', {
    allow_custom: { mode: 'selected', user_ids: [81] },
  });
  assert.equal(accessResult.status, 200);
  assert.equal(store.policy(81).allow_custom, true);
  assert.equal(store.policy(82).allow_custom, false);
  assert.equal(store.policy(82).show_catalog, true, 'permissions stay independent');
  await request('/admin/access', 'PUT', { show_catalog: { mode: 'none' } });
  assert.equal(store.policy(81).show_catalog, false);
  assert.equal(store.policy(81).allow_custom, true);
  assert.equal((await request('/user/81/mcp')).body.servers.length, 0);
  await request('/admin/access', 'PUT', { show_catalog: { mode: 'all', excluded_user_ids: [82] } });
  assert.equal(store.policy(81).show_catalog, true);
  assert.equal(store.policy(82).show_catalog, false);
  assert.deepEqual(
    (await request('/admin/access')).body.access.show_catalog.excluded_user_ids,
    [82],
  );
  const beforeInvalid = JSON.stringify(store.accessSettings());
  assert.equal(
    (
      await request('/admin/access', 'PUT', {
        allow_custom: { mode: 'all' },
        show_catalog: { mode: 'selected', user_ids: [999999] },
      })
    ).status,
    404,
  );
  assert.equal(
    JSON.stringify(store.accessSettings()),
    beforeInvalid,
    'invalid bulk updates are atomic',
  );
  assert.equal(
    (
      await request('/admin/access', 'PUT', {
        allow_custom: { mode: 'selected', user_ids: ['81'] },
      })
    ).status,
    400,
  );
  await request('/admin/policy', 'PUT', { enabled: false });
  assert.equal(store.policy(81).enabled, false);
  assert.equal(
    store.policy(81).allow_custom,
    true,
    'global enable switch preserves selected users',
  );
  await request('/admin/access', 'PUT', {
    allow_custom: { mode: 'none' },
    show_catalog: { mode: 'all' },
  });
  assert.equal(store.policy(81).allow_custom, false);
  await request('/admin/policy', 'PUT', { enabled: true });
  await request('/admin/users/82', 'PUT', { override: 'allow' });
  console.log(
    'PASS: central access modes, user selection, legacy exclusions, independent permissions and atomic validation',
  );
  const oauthConnection = store.saveConnection(82, {
    name: 'OAuth MCP',
    url: 'https://oauth-mcp.example/mcp',
  });
  assert.equal(store.policy().oauth_callback_url, '');
  assert.equal((await request('/admin/policy','PUT',{oauth_callback_url:'http://unsafe.example/callback'})).status,400);
  assert.equal((await request('/admin/policy','PUT',{oauth_callback_url:'https://safe.example/callback?secret=x'})).status,400);
  assert.equal(store.policy().oauth_callback_url, '', 'invalid settings leave policy unchanged');
  const authResponse = await request('/user/82/mcp/connections/'+oauthConnection.id+'/oauth','POST',{callback_url:expectedCallback});
  assert.equal(authResponse.status,200);
  const authorization = authResponse.body;
  oauthUrl = new URL(authorization.authorization_url);
  assert.equal(oauthUrl.origin, 'https://auth.example');
  assert.equal(oauthUrl.searchParams.get('redirect_uri'), expectedCallback);
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
  assert.equal((await request('/admin/policy','PUT',{oauth_callback_url:'https://changed.example/backend/mcp/oauth/callback'})).status,200);
  const callbackResponse = await fetch(apiBase+'/mcp/oauth/callback?'+new URLSearchParams({state,code:'test-authorization-code'}));
  assert.equal(callbackResponse.status,200,'public callback works without Chatter credentials');
  assert.match(await callbackResponse.text(),/MCP connected/);
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
  // Administrator override wins over the automatic client address, and survives a DB read.
  const overridden = await client.beginOAuth(82, oauthConnection.id, 'https://automatic.example/mcp/oauth/callback');
  const overrideUrl = new URL(overridden.authorization_url);
  assert.equal(overrideUrl.searchParams.get('redirect_uri'), 'https://changed.example/backend/mcp/oauth/callback');
  assert.equal(store.policy().oauth_callback_url, 'https://changed.example/backend/mcp/oauth/callback');
  await assert.rejects(()=>client.finishOAuth(overrideUrl.searchParams.get('state')!, '', 'access_denied'),/mcp_authorization_declined/);
  assert.equal((await request('/admin/policy','PUT',{oauth_callback_url:''})).status,200);
  assert.equal(store.policy().oauth_callback_url, '');
  for (const bad of ['http://unsafe.example/callback', 'https://localhost/mcp/oauth/callback','https://user:pass@host.example/callback','https://safe.example/callback#fragment'])
    await assert.rejects(()=>client.beginOAuth(82,oauthConnection.id,bad),/mcp_invalid_callback_url/);
  await assert.rejects(()=>client.beginOAuth(82,oauthConnection.id),/mcp_oauth_callback_not_configured/);
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
  wsClients.clear();
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
