'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ACTIVE = new Set(['queued', 'running', 'recovery_required']);
const KEYS = { jwt: 'API_JWT_SECRET', internal: 'BACKEND_INTERNAL_TOKEN', encryption: 'ENCRYPTION_KEY' };

function createSecretRotation(options) {
  const { configDir, dataDir, atomicWrite, parseEnv } = options;
  const stateFile = path.join(configDir, 'secret-rotation.json');
  const database = path.join(dataDir, 'chatter.db');
  const marker = path.join(dataDir, '.secret-rotation-maintenance');
  let pending = null;
  let persistenceFault = false;
  function read() {
    if (!fs.existsSync(stateFile)) return { status: 'idle' };
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!['queued', 'running', 'recovery_required', 'complete', 'failed'].includes(s.status)
        || !KEYS[s.kind] || !/^[a-f\d-]{36}$/.test(s.id || '')) throw new Error('bad_journal');
      return s;
    }
    catch { throw new Error('secret_rotation_journal_unreadable'); }
  }
  function status() {
    if (persistenceFault) return { status: 'recovery_required', error: 'secret_rotation_journal_write_failed' };
    try {
      const s = read();
      if (fs.existsSync(marker) && !ACTIVE.has(s.status)) return { status: 'recovery_required', error: 'secret_rotation_journal_missing' };
      return { status: s.status, kind: s.kind, phase: s.phase, id: s.id, updatedAt: s.updatedAt, backup: s.backup, fields: s.fields, error: s.error, reason: s.reason };
    } catch { return { status: 'recovery_required', error: 'secret_rotation_journal_unreadable' }; }
  }
  const blocked = () => Boolean(pending) || ACTIVE.has(status().status);
  function save(s) {
    s.updatedAt = new Date().toISOString();
    atomicWrite(stateFile, JSON.stringify(s, null, 2) + '\n');
  }
  function syncFile(file) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  function syncDir(dir) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function durable(s) { save(s); syncFile(stateFile); syncDir(configDir); }
  function clearMarker() { fs.rmSync(marker, { force: true }); syncDir(dataDir); }
  function snapshots(s) {
    if (!/^[a-f\d-]{36}$/.test(s.id || '')) throw new Error('bad_rotation_journal');
    return path.join(configDir, `.secret-rotation-${s.id}`);
  }
  async function rollback(s) {
    s.status = 'running'; s.phase = 'rolling_back'; durable(s);
    await options.stop(s.services);
    const dir = snapshots(s);
    if (s.snapshotReady) {
      for (const name of ['backend.env', 'telegram.env']) {
        if (s.files.includes(name)) atomicWrite(path.join(configDir, name), fs.readFileSync(path.join(dir, name)));
        else fs.rmSync(path.join(configDir, name), { force: true });
        if (fs.existsSync(path.join(configDir, name))) syncFile(path.join(configDir, name));
      }
      if (s.kind === 'encryption') {
        const temporary = path.join(dataDir, `.rotation-restore-${s.id}.sqlite`);
        fs.copyFileSync(path.join(dir, 'database.sqlite'), temporary);
        if (process.platform !== 'win32') fs.chownSync(temporary, s.uid, s.gid);
        fs.chmodSync(temporary, s.mode);
        syncFile(temporary);
        fs.renameSync(temporary, database);
        for (const suffix of ['-wal', '-shm']) fs.rmSync(database + suffix, { force: true });
      }
      syncDir(configDir); syncDir(dataDir);
    }
    // Persist the matched OLD pair before allowing any service to start.
    s.phase = 'rolled_back'; durable(s); clearMarker();
    await options.restart(s.services);
    await options.check();
    s.status = 'failed'; s.error = 'rotation_failed_rolled_back'; durable(s);
  }
  async function finish(s) {
    // Recovery may encounter an env changed outside the manager. Check the DB
    // before starting writers, even when the rotated secret was only JWT.
    if (options.validate) await options.validate();
    clearMarker();
    await options.restart(s.services);
    await options.check();
    s.phase = 'complete'; s.status = 'complete'; delete s.error; delete s.reason; durable(s);
  }
  async function execute(s) {
    try {
      s.status = 'running'; s.phase = 'preflight'; durable(s);
      await options.preflight(s.kind);
      s.services = await options.services();
      if (!s.services.includes('backend')) throw new Error('backend_not_running');
      s.phase = 'stopping'; durable(s);
      atomicWrite(marker, s.id + '\n'); syncFile(marker); syncDir(dataDir);
      await options.stop(s.services);
      s.phase = 'backup'; durable(s);
      const dir = snapshots(s);
      fs.mkdirSync(dir, { mode: 0o700 });
      s.files = [];
      for (const name of ['backend.env', 'telegram.env']) {
        const file = path.join(configDir, name);
        if (fs.existsSync(file)) { fs.copyFileSync(file, path.join(dir, name)); fs.chmodSync(path.join(dir, name), 0o600); syncFile(path.join(dir, name)); s.files.push(name); }
      }
      const owner = fs.statSync(database);
      s.uid = owner.uid; s.gid = owner.gid; s.mode = owner.mode & 0o777;
      if (s.kind === 'encryption') {
        await options.snapshot(path.join(dir, 'database.sqlite'));
        syncFile(path.join(dir, 'database.sqlite'));
      }
      syncDir(dir); syncDir(configDir);
      s.snapshotReady = true; durable(s);
      s.backup = (await options.backup()).name; durable(s);
      const backendFile = path.join(configDir, 'backend.env');
      const backend = parseEnv(backendFile);
      const oldKey = backend[KEYS[s.kind]];
      if (!oldKey) throw new Error('secret_not_configured');
      const newKey = crypto.randomBytes(32).toString('hex');
      if (s.kind === 'encryption') {
        s.phase = 'reencrypting'; durable(s);
        const stage = path.join(dataDir, `.rotation-stage-${s.id}.sqlite`);
        fs.copyFileSync(path.join(dir, 'database.sqlite'), stage);
        s.fields = (await options.transform(stage, oldKey, newKey, backend)).fields;
        // Verify the persisted ciphertext with the new key in a separate process.
        await options.transform(stage, newKey, newKey, backend, true);
        if (process.platform !== 'win32') fs.chownSync(stage, s.uid, s.gid);
        fs.chmodSync(stage, s.mode); syncFile(stage);
        s.phase = 'publishing'; durable(s);
        fs.renameSync(stage, database);
        for (const suffix of ['-wal', '-shm']) fs.rmSync(database + suffix, { force: true });
        syncDir(dataDir);
      }
      options.updateEnv(backendFile, KEYS[s.kind], newKey);
      const telegramFile = path.join(configDir, 'telegram.env');
      if (s.kind === 'internal') options.updateEnv(telegramFile, KEYS[s.kind], newKey);
      else if (s.kind === 'encryption' && parseEnv(telegramFile).ENCRYPTION_KEY === oldKey) options.updateEnv(telegramFile, 'ENCRYPTION_KEY', newKey);
      syncFile(backendFile);
      if (fs.existsSync(telegramFile)) syncFile(telegramFile);
      syncDir(configDir);
      // Commit point: after this, recovery retries startup, never discards new writes.
      s.phase = 'committed'; durable(s);
      await finish(s);
    } catch (error) {
      const allowed = ['running_secret_config_mismatch', 'admin_requests_busy', 'backend_secret_env_override', 'internal_token_env_override', 'backend_start_command_override', 'not_enough_space_for_secret_rotation', 'backend_rotation_helper_missing', 'active_generations_try_later', 'backend_not_running', 'secret_not_configured'];
      const message = String(error?.message || '');
      s.reason = allowed.includes(message) ? message
        : message.includes('cannot_reencrypt:') ? 'encrypted_record_unreadable'
        : ['ENOSPC', 'EACCES', 'EPERM'].includes(error?.code) ? 'storage_write_failed' : 'operation_failed';
      if (s.phase === 'committed' || s.phase === 'complete') {
        s.status = 'recovery_required'; s.error = 'rotation_committed_restart_required'; durable(s);
      } else if (s.services?.length) {
        try { await rollback(s); }
        catch { s.status = 'recovery_required'; s.error = 'rotation_recovery_required'; durable(s); }
      } else {
        if (options.cancelPrepare) { try { await options.cancelPrepare(); } catch {} }
        s.status = 'failed'; s.error = 'rotation_preflight_failed'; durable(s);
      }
    }
    return status();
  }
  function start(kind) {
    if (!KEYS[kind]) throw new Error('invalid_rotation_kind');
    if (blocked()) throw new Error('secret_rotation_in_progress');
    const s = { id: crypto.randomUUID(), kind, status: 'queued', phase: 'queued' };
    try { durable(s); } catch { persistenceFault = true; throw new Error('secret_rotation_journal_write_failed'); }
    pending = options.exclusive(() => execute(s)).finally(() => { pending = null; });
    pending.catch(() => { persistenceFault = true; });
    return status();
  }
  function recover() {
    if (pending) return pending;
    const s = read();
    if (!ACTIVE.has(s.status)) {
      if (persistenceFault) { if (s.status !== 'idle') durable(s); persistenceFault = false; }
      return Promise.resolve(status());
    }
    pending = options.exclusive(async () => {
      try {
        if (s.phase === 'committed' || s.phase === 'complete') await finish(s);
        else if (s.phase === 'rolled_back') {
          clearMarker(); await options.restart(s.services); await options.check();
          s.status = 'failed'; s.error = 'rotation_failed_rolled_back'; durable(s);
        }
        else if (s.services?.length) await rollback(s);
        else {
          if (options.cancelPrepare) { try { await options.cancelPrepare(); } catch {} }
          s.status = 'failed'; s.error = 'rotation_interrupted_before_changes'; durable(s);
        }
        persistenceFault = false;
      } catch { s.status = 'recovery_required'; s.error = 'rotation_recovery_required'; durable(s); }
      return status();
    }).finally(() => { pending = null; });
    pending.catch(() => { persistenceFault = true; });
    return pending;
  }
  return { start, recover, status, blocked };
}
module.exports = { createSecretRotation };
