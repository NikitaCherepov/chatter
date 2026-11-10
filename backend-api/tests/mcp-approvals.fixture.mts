import assert from 'node:assert/strict';
export async function checkApprovals({ tools, store, connection, received, require }: any) {
  const {
    getPendingPcConfirmation,
    deletePendingPcConfirmation,
  } = require('../src/services/pc-command-confirmations.ts');
  const { saveMcpApproval } = require('../src/services/mcp/approval-policy.ts');
  const blank = () => ({ allow_all: false, tools: [], resources: [] });
  const reset = () => store.saveConnection(81, { approval_policy: blank() }, connection.id);
  const count = () =>
    received.filter((x: any) => ['tools/call', 'resources/read'].includes(x.body.method)).length;
  const args = () => ({
    connection_id: connection.id,
    tool: 'echo',
    arguments: { text: 'approved' },
  });
  async function queued(input = args(), name = 'call_mcp_tool', signal?: AbortSignal) {
    let action: any;
    const original = structuredClone(input),
      before = count();
    const promise = tools.runMcpTool(81, name, input, signal, undefined, undefined, {
      onDesktopAction: (a: any) => {
        if (a.action === 'mcp_confirmation') action = a;
      },
    });
    void promise.catch(() => {});
    for (let n = 0; !action && n < 100; n++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(action, 'confirmation delivered');
    assert.equal(count(), before, 'nothing executes before approval');
    const id = action.value.confirmation_id;
    const pending = getPendingPcConfirmation(id);
    assert.equal(pending.userId, 81);
    assert.deepEqual(
      action.value.arguments,
      name === 'read_mcp_resource' || name.startsWith('mcp_') ? original : original.arguments,
    );
    return { promise, action, pending, id, input };
  }
  async function allow(q: any, remember = false) {
    assert.equal(deletePendingPcConfirmation(q.id), true);
    assert.equal(getPendingPcConfirmation(q.id), undefined, 'consumed before executing');
    try {
      const result = await q.pending.execute({ remember });
      q.pending.resolve(result);
    } catch (e) {
      q.pending.reject(e);
    }
    return q.promise;
  }
  async function reject(q: any, message: string) {
    deletePendingPcConfirmation(q.id);
    q.pending.reject(new Error(message));
    return q.promise;
  }
  // Execute the actual two Express handlers without booting production services.
  const source = require('node:fs').readFileSync(
    new URL('../src/server.ts', import.meta.url),
    'utf8',
  );
  const handlers = new Map<string, Function>(),
    pc = require('../src/services/pc-command-confirmations.ts');
  const deps: any = {
    app: { post: (url: string, ...fns: Function[]) => handlers.set(url, fns.at(-1)!) },
    internalAuth: () => {},
    accountIdFromRequest: (req: any) => req.accountId,
    resolveInternalAccountId: (id: any) => Number(id),
    getPendingPcConfirmation: pc.getPendingPcConfirmation,
    deletePendingPcConfirmation: pc.deletePendingPcConfirmation,
    dismissMissingBrowserConfirmation: () => {},
    cancelRejectedBrowserDownload: () => {},
    getBrowserSessionPermissionGrant: () => null,
    notifyConfirmationResolved: () => {},
    notifyPcConfirmationResolved: (pending: any, _id: string, status: any) =>
      pending.onResolved?.(status),
    buildRejectedByUserError: (comment: any) =>
      new Error('rejected_by_user' + (comment ? ':' + comment : '')),
    require: () => ({
      sendIpcToDesktop: () => {
        throw new Error('MCP must not use raw desktop IPC');
      },
    }),
    console: { log() {}, warn() {}, error() {} },
  };
  for (const url of ['/api/v1/pc-commands/approve', '/internal/pc-commands/approve']) {
    const start = source.indexOf("app.post('" + url + "'"),
      end = source.indexOf('\n});', start) + 5;
    assert.ok(start > 0 && end > start);
    const js = require('typescript').transpileModule(source.slice(start, end), {
      compilerOptions: {
        module: require('typescript').ModuleKind.CommonJS,
        target: require('typescript').ScriptTarget.ES2022,
      },
    }).outputText;
    new Function(...Object.keys(deps), js)(...Object.values(deps));
  }
  async function route(url: string, q: any, body: any = {}, owner = 81) {
    const res: any = {
      code: 200,
      status(n: number) {
        this.code = n;
        return this;
      },
      json(data: any) {
        this.body = data;
        return this;
      },
    };
    await handlers.get(url)!(
      {
        accountId: owner,
        body: { user_id: owner, confirmation_id: q.id, approved: true, ...body },
      },
      res,
    );
    return res;
  }
  for (const url of handlers.keys()) {
    reset();
    const q = await queued();
    assert.equal((await route(url, q, {}, 82)).code, 403, 'another account cannot approve');
    assert.ok(getPendingPcConfirmation(q.id));
    assert.equal((await route(url, q, { remember_mcp: true })).code, 200);
    assert.match(await q.promise, /success/);
    assert.equal((await route(url, q)).code, 404, 'second approval cannot execute again');
    reset();
    const rejected = await queued();
    assert.equal(
      (await route(url, rejected, { approved: false, rejection_comment: 'stop please' })).code,
      200,
    );
    assert.match(await rejected.promise, /stop please/);
  }
  reset();
  assert.deepEqual(
    store.publicConnection(store.requireConnection(81, connection.id)).approval_policy,
    blank(),
  );
  const before = count();
  await tools.runMcpTool(81, 'browse_mcp', { connection_id: connection.id });
  assert.equal(count(), before, 'discovery does not invoke tools or resources');
  let q = await queued();
  q.input.arguments.text = 'changed after prompt';
  assert.match(await allow(q), /approved/, 'executes captured arguments');
  q = await queued();
  assert.match(await reject(q, 'rejected_by_user:do not send'), /do not send/);
  q = await queued();
  assert.match(await allow(q, true), /success/);
  const approvedAt = count();
  await tools.runMcpTool(81, 'call_mcp_tool', {
    ...args(),
    arguments: { text: 'other arguments' },
  });
  assert.equal(count(), approvedAt + 1, 'saved permission covers same tool with other arguments');
  assert.deepEqual(
    store.publicConnection(store.requireConnection(81, connection.id)).approval_policy.tools,
    ['echo'],
  );
  // A different tool still asks, including eager native names.
  // Generic operation selected explicitly: wait must never be executed in this test.
  q = await queued({ connection_id: connection.id, tool: 'wait', arguments: {} });
  assert.match(await reject(q, 'rejected_by_user'), /rejected/);
  reset();
  q = await queued({ connection_id: connection.id, uri: 'notes://guide' }, 'read_mcp_resource');
  await allow(q, true);
  const resourceAt = count();
  await tools.runMcpTool(81, 'read_mcp_resource', {
    connection_id: connection.id,
    uri: 'notes://guide',
    offset: 1,
    max_chars: 10,
  });
  assert.equal(count(), resourceAt + 1, 'same resource permission covers pages');
  q = await queued(
    { connection_id: connection.id, uri: 'notes://project/another' },
    'read_mcp_resource',
  );
  await reject(q, 'rejected_by_user');
  reset();
  const controller = new AbortController();
  q = await queued(args(), 'call_mcp_tool', controller.signal);
  controller.abort(new Error('test_cancel'));
  await assert.rejects(q.promise, /test_cancel/);
  assert.equal(getPendingPcConfirmation(q.id), undefined, 'aborted cards removed');
  q = await queued();
  await assert.doesNotReject(() => reject(q, 'confirmation_expired'));
  q = await queued();
  store.saveConnection(81, { name: 'changed server' }, connection.id);
  await assert.rejects(() => allow(q, true), /mcp_confirmation_stale/);
  assert.deepEqual(
    store.publicConnection(store.requireConnection(81, connection.id)).approval_policy.tools,
    [],
    'stale card cannot grant',
  );
  store.saveConnection(81, { name: connection.name }, connection.id);
  reset();
  let prompts = 0;
  const silent = await tools.runMcpTool(
    81,
    'call_mcp_tool',
    args(),
    undefined,
    undefined,
    undefined,
    {
      autoRejectHitl: true,
      onDesktopAction: () => {
        prompts++;
      },
    },
  );
  assert.match(silent, /mcp_confirmation_required/);
  assert.equal(prompts, 0);
  await saveMcpApproval(81, connection.id, { allow_all: false, tools: ['echo'], resources: [] });
  assert.match(
    await tools.runMcpTool(81, 'call_mcp_tool', args(), undefined, undefined, undefined, {
      autoRejectHitl: true,
    }),
    /success/,
  );
  reset();
  // Eager aliases take the same gate.
  store.saveConnection(81, { mode: 'eager' }, connection.id);
  const eager = tools
    .getMcpDefinitions(81)
    .find(
      (t: any) => t.function.name.startsWith('mcp_') && t.function.description.includes('Echo'),
    );
  assert.ok(eager);
  q = await queued({ text: 'eager approved' }, eager.function.name);
  await reject(q, 'rejected_by_user');
  store.saveConnection(81, { mode: 'search' }, connection.id);
  reset();
  const approvalUrl = '/api/v1/pc-commands/approve';
  let finishInstall!: (result: string) => void, settleInstall!: (result: string) => void;
  const installExecution = new Promise<string>((resolve) => { finishInstall = resolve; });
  const installResult = new Promise<string>((resolve) => { settleInstall = resolve; });
  const install = { id: 'fixture-install-confirmation' };
  pc.registerPendingPcConfirmation(install.id, {
    userId: 81,
    kind: 'mcp_action',
    label: 'Fixture MCP',
    payload: { ipcType: 'mcp', ipcPayload: { operation: 'install', target: 'stdio', arguments: {} } },
    execute: ({ remember }: any) => {
      assert.equal(remember, false);
      return installExecution;
    },
    resolve: settleInstall,
    reject: () => assert.fail('fixture install should succeed'),
    createdAt: Date.now(),
  });
  const accepted = await route(approvalUrl, install, { remember_mcp: true });
  assert.equal(accepted.code, 202, 'approval returns while the installer is running');
  assert.equal(accepted.body.status, 'executing');
  assert.equal(getPendingPcConfirmation(install.id), undefined);
  finishInstall('installed');
  assert.equal(await installResult, 'installed');
  async function configure(input: any, beforeApproval?: () => void) {
    let card: any;
    const run = tools.runMcpTool(81, 'configure_mcp', { connection_id: connection.id, ...input },
      undefined, undefined, undefined, { onDesktopAction: (action: any) => {
        if (action.action === 'mcp_confirmation') card = action.value;
      } });
    void run.catch(() => {});
    assert.equal(card.operation, input.action === 'read' ? 'config_read' : 'config_update');
    beforeApproval?.();
    await route(approvalUrl, { id: card.confirmation_id });
    return JSON.parse(await run);
  }
  assert.deepEqual((await configure({ action: 'read', looking_for: 'credentials' })).settings,
    { has_credentials: true });
  const originalTimeout = store.requireConnection(81, connection.id).timeout_seconds;
  await assert.rejects(() => configure({ action: 'update', patch: { timeout_seconds: 90 } }, () =>
    store.saveConnection(81, { timeout_seconds: 91 }, connection.id)), /mcp_confirmation_stale/);
  assert.equal(store.requireConnection(81, connection.id).timeout_seconds, 91);
  assert.equal((await configure({ action: 'update', patch: { timeout_seconds: originalTimeout } })).status, 'updated');
  console.log(
    'MCP confirmation checks passed: captured args, once/remember, resource scope, rejection, cancellation, stale grants, background, eager',
  );
}
