// Run with: node --test chatter-manager/server-update.test.cjs
// Execute production functions in isolation, without starting the HTTP server
// or touching a real Docker daemon. TypeScript is an existing admin dependency.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('../admin-panel/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function manager(names, mocks = {}) {
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text));
  assert.equal(declarations.length, names.length);
  const context = vm.createContext({ Buffer, console, os, ...mocks });
  vm.runInContext(declarations.map(node => node.getText(ast)).join('\n'), context);
  return context;
}
const stateSource = fs.readFileSync(path.join(__dirname, '../admin-panel/lib/services/serverUpdateState.ts'), 'utf8');
const stateContext = vm.createContext({ exports: {} });
vm.runInContext(ts.transpileModule(stateSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, stateContext);
const { visibleUpdateStatus } = stateContext.exports;

// Actual hashes from the user's failed update and the published sha-e9c54d5
// registry image. They identify the SAME release, at different OCI levels.
const CONFIG_ID = 'sha256:82c6d212f82283f208f348262838d708fa536e8a7b37bfcedfb300e7392e8078';
const INDEX_ID = 'sha256:2dcf195eb3e2e7ab8593c5adf973d58a4a448adc11d89da19b7aeb797a49828b';
const MANIFEST_ID = 'sha256:8462eed0bf6c5738b3ee29e72ed84b67dd24cc59569f8f6f76e9aea228321ab6';
const REPO = 'ghcr.io/nikitacherepov/chatter-manager';
const REF = `${REPO}:updater-fixing`;
const selection = { profiles: ['*'], services: ['chatter-manager'], releaseServices: ['chatter-manager'], images: { 'chatter-manager': REF } };
function manifest(id = CONFIG_ID) {
  return [
    { Descriptor: { platform: { architecture: 'unknown', os: 'unknown' } }, OCIManifest: { config: { digest: 'attestation' } } },
    { Descriptor: { digest: MANIFEST_ID, platform: { architecture: 'amd64', os: 'linux' } }, OCIManifest: { config: { digest: id }, layers: [{ size: 20 }] } },
  ];
}
function fixture({ classic = false, old = false } = {}) {
  let runningId = old ? `sha256:${'1'.repeat(64)}` : classic ? CONFIG_ID : INDEX_ID;
  let operation = { status: 'idle', updatedAt: null, targetHash: '' };
  const calls = [];
  const ctx = manager(['inspectImage', 'imageContentId', 'dockerArchitecture', 'inspectRemoteImage', 'decodeImageChangelog', 'inspectRunningService', 'shortImageHash', 'getServerUpdateInfoUnlocked', 'attachUpdateOperation'], {
    os: { arch: () => 'x64' },
    imageContentIdCache: new Map(), serverUpdateSnapshotCache: null, PULL_COOLDOWN_MS: 300000,
    currentImagePrefix: () => 'ghcr.io/nikitacherepov/chatter', currentImageTag: () => 'updater-fixing',
    serverUpdatesSupported: () => true, updateServiceSelection: async () => selection,
    readUpdateState: () => operation, composeArgs: (...args) => ['compose', ...args],
    buildUpdateStorageInfo: comparisons => ({ sufficient: true, requiredBytes: comparisons.some(item => item.changed) ? 20 : 0 }),
    runDocker: async args => {
      calls.push(args);
      const ref = args.at(-1);
      if (args[0] === 'compose') return 'manager-container';
      if (args[0] === 'inspect') return JSON.stringify({ Image: runningId, Config: { Image: REF, Labels: {} } });
      if (args[0] === 'image') {
        const id = ref === REF ? (classic ? CONFIG_ID : INDEX_ID) : ref;
        return JSON.stringify({ Id: id, Config: { Labels: {} }, ...(classic ? {} : {
          Descriptor: { digest: id, mediaType: 'application/vnd.oci.image.index.v1+json' }, RepoDigests: [`${REPO}@${id}`],
        }) });
      }
      if (args[0] === 'manifest') return JSON.stringify(manifest(ref.endsWith('1'.repeat(64)) ? `sha256:${'2'.repeat(64)}` : CONFIG_ID));
      throw new Error(`Unexpected Docker call: ${args}`);
    },
  });
  return { ctx, calls, setRunning: id => { runningId = id; }, setOperation: value => { operation = value; } };
}

test('containerd: the exact two hashes in the failure log are the same installed release', async () => {
  const { ctx, calls } = fixture();
  const info = await ctx.getServerUpdateInfoUnlocked();
  assert.equal(info.available, false);
  assert.equal(info.installedHash, '82c6d212f822');
  assert.equal(info.latestHash, info.installedHash);
  assert.equal(info.storage.requiredBytes, 0);
  assert.ok(calls.some(args => args.at(-1) === `${REPO}@${INDEX_ID}`));
  assert.ok(!calls.some(args => args.includes('pull')));
});

test('classic Docker: config IDs compare directly, with no extra immutable registry lookup', async () => {
  const { ctx, calls } = fixture({ classic: true });
  assert.equal((await ctx.getServerUpdateInfoUnlocked()).available, false);
  assert.equal(calls.filter(args => args[0] === 'manifest').length, 1);
});

test('pull without recreate: compare the running image, not the new local tag', async () => {
  const { ctx } = fixture({ old: true });
  const info = await ctx.getServerUpdateInfoUnlocked();
  assert.equal(info.available, true);
  assert.equal(info.installedHash, '222222222222');
  assert.equal(info.latestHash, '82c6d212f822');
});

test('terminal transition invalidates the old container snapshot without forging installedHash', async () => {
  const f = fixture({ old: true });
  f.setOperation({ status: 'restarting', operationId: 'attempt-a', targetHash: '82c6d212f822', updatedAt: 'before' });
  assert.equal((await f.ctx.getServerUpdateInfoUnlocked()).available, true);
  f.setRunning(INDEX_ID);
  f.setOperation({ status: 'complete', operationId: 'attempt-a', targetHash: '82c6d212f822', updatedAt: 'after' });
  const done = await f.ctx.getServerUpdateInfoUnlocked();
  assert.equal(done.available, false);
  assert.equal(done.installedHash, done.latestHash);
  assert.equal(done.operation.status, 'complete');
});

test('active operation serves the cached snapshot instantly, with no Docker work', async () => {
  const f = fixture();
  f.ctx.serverUpdateSnapshotCache = {
    key: `${REPO.replace('-manager', '')}:updater-fixing`,
    checkedAtMs: 0, // cooldown long expired — must not trigger re-inspection mid-operation
    operationUpdatedAt: 'before',
    value: { supported: true, installedHash: 'old', latestHash: '82c6d212f822', available: true, changedServices: ['chatter-manager'], changelog: {}, rebuiltFromSameCommit: false, checkedAt: null },
  };
  f.setOperation({ status: 'pulling', operationId: 'attempt-a', targetHash: '82c6d212f822', updatedAt: 'now' });
  const info = await f.ctx.getServerUpdateInfoUnlocked();
  assert.equal(info.operation.status, 'pulling');
  assert.equal(info.latestHash, '82c6d212f822');
  assert.equal(f.calls.length, 0);
});

test('failed rollback remains available and the failure is not converted to idle', async () => {
  const f = fixture({ old: true });
  f.setOperation({ status: 'failed', operationId: 'attempt-a', targetHash: 'different-target', updatedAt: 'after' });
  const info = await f.ctx.getServerUpdateInfoUnlocked();
  assert.equal(info.available, true);
  assert.equal(info.operation.status, 'failed');
  assert.equal(visibleUpdateStatus(info.operation, 'attempt-a'), 'failed');
});

test('UI: old complete cannot finish a newly opened confirmation or a pending POST', () => {
  const previous = { operationId: 'old', status: 'complete', targetHash: 'a' };
  assert.equal(visibleUpdateStatus(previous, null), 'idle');
  assert.equal(visibleUpdateStatus(previous, 'pending'), 'queued');
  assert.equal(visibleUpdateStatus(previous, 'new'), 'idle');
});

test('UI: all stages finish the accepted attempt even if its target or the registry tag changes', () => {
  for (const status of ['queued', 'pulling', 'backup', 'restarting', 'complete', 'failed']) {
    assert.equal(visibleUpdateStatus({ operationId: 'new', status, targetHash: status }, 'new'), status);
  }
  assert.equal(visibleUpdateStatus({ operationId: 'new', status: 'pulling' }, null), 'pulling');
});

test('manifest parsing never treats descriptor digest or attestation as a config ID', async () => {
  const { ctx } = fixture();
  ctx.runDocker = async () => JSON.stringify([{ Descriptor: { digest: INDEX_ID, platform: { architecture: 'unknown', os: 'unknown' } } }]);
  await assert.rejects(ctx.inspectRemoteImage(REF), /remote_image_manifest_invalid/);
});

test('post-pull target uses config identity, verification uses the full local Docker ID', async () => {
  let invocation;
  const stages = [];
  const ctx = manager(['performServerUpdate', 'shortImageHash'], {
    console, assertUpdateStorage() {}, assertBackupStorageAvailable() {},
    updateServiceSelection: async () => selection, captureRollbackImages: async () => [],
    writeUpdateState: state => stages.push(state), pullServerUpdateImages: async () => ({ selection, updatedDeploymentFiles: [] }),
    ensureSelectedImagesAvailable: async () => {}, inspectImage: async () => ({ id: INDEX_ID }),
    imageContentId: async () => CONFIG_ID, stopDataServicesForUpdate: async () => {},
    createBackup: async () => {}, pruneAutomaticBackups: async () => {}, getBackupSchedule: () => ({ retention: 3 }),
    launchServerUpdateHelper: async (...args) => { invocation = args; },
  });
  await ctx.performServerUpdate({ latestHash: 'old-preflight', storage: {} }, 'attempt-a');
  assert.equal(invocation[0], '82c6d212f822');
  assert.equal(invocation[4], INDEX_ID);
  assert.equal(invocation[5], 'attempt-a');
  assert.equal(stages.find(stage => stage.status === 'backup').targetHash, '82c6d212f822');
});

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
for (const mode of ['success', 'mismatch', 'compose_failure']) {
  test(`execute actual updater shell: ${mode}`, { skip: !fs.existsSync(bash) }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-update-test-'));
    let invocation;
    try {
      const ctx = manager(['shellProfileArgs', 'launchServerUpdateHelper'], {
        HOST_PROJECT_DIR: directory, HOST_CONFIG_DIR: directory, PROJECT_NAME: 'test-chatter',
        runDocker: async args => { invocation = args; },
      });
      await ctx.launchServerUpdateHelper('82c6d212f822', selection, selection, [], INDEX_ID, 'attempt-a');
      const script = invocation.at(-1);
      const shellMocks = `
sleep() { :; }
docker() {
  printf '%s\\n' "$*" >> "$HOST_CONFIG_DIR/docker-calls.log"
  case "$*" in
    'ps -a -q '*) echo previous-container ;;
    *'{{.Config.Image}}'*) echo '${REF}' ;;
    *'{{.Image}} previous-container') echo 'sha256:previous' ;;
    *'{{.Image}} updated-container')
      if [ "$TEST_MODE" = mismatch ]; then echo 'sha256:unexpected'; else echo '${INDEX_ID}'; fi ;;
    *'ps -q chatter-manager') echo updated-container ;;
    *'--wait --wait-timeout'*)
      echo 'mock compose output'
      if [ "$TEST_MODE" = compose_failure ]; then echo 'mock healthcheck failed' >&2; return 17; fi ;;
  esac
  return 0
}
`;
      const result = spawnSync(bash, ['-c', shellMocks + script], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, HOST_PROJECT_DIR: directory.replaceAll('\\', '/'), HOST_CONFIG_DIR: directory.replaceAll('\\', '/'),
          COMPOSE_PROJECT_NAME: 'test-chatter', TARGET_HASH: '82c6d212f822', TARGET_IMAGE_ID: INDEX_ID, OPERATION_ID: 'attempt-a', TEST_MODE: mode },
      });
      assert.ifError(result.error);
      const state = JSON.parse(fs.readFileSync(path.join(directory, 'server-update.json'), 'utf8'));
      const log = fs.readFileSync(path.join(directory, 'server-update.log'), 'utf8');
      const calls = fs.readFileSync(path.join(directory, 'docker-calls.log'), 'utf8');
      assert.equal(state.operationId, 'attempt-a');
      assert.equal(state.targetHash, '82c6d212f822');
      assert.equal(state.status, mode === 'success' ? 'complete' : 'failed');
      assert.equal(result.status, mode === 'success' ? 0 : mode === 'mismatch' ? 43 : 17);
      assert.match(log, /mock compose output/);
      assert.match(calls, /image prune -f/);
      if (mode === 'success') {
        assert.doesNotMatch(calls, /image tag/);
        assert.equal(visibleUpdateStatus(state, 'attempt-a'), 'complete');
      } else {
        assert.match(log, /previous services restored/);
        assert.match(calls, /image tag sha256:previous/);
        assert.equal(visibleUpdateStatus(state, 'attempt-a'), 'failed');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
