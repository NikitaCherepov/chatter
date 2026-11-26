import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { ThemeStorageSnapshot } from '../src/main/theme-storage-types';
const require = createRequire(import.meta.url);
const { ThemeStorage } = require('../src/main/theme-storage');
const { ThemeStorageClient } = require('../src/interactive/theme-storage-store');
const { cloneThemeStorageValue } = require('../src/main/theme-storage-types');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-theme-state-'));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('atomic device storage survives restart, isolates themes and rejects invalid/corrupt data', () => {
  const directory = temporary();
  try {
    const store = new ThemeStorage(directory),
      events: unknown[] = [];
    const off = store.subscribe('alpha', (snapshot, origin) =>
      events.push([snapshot.revision, origin]),
    );
    assert.deepEqual(store.read('alpha'), { revision: 0, values: {} });
    store.request(
      'alpha',
      { operation: 'set', key: 'windows', value: [{ x: 12, y: 30 }], revision: 0 },
      'renderer',
    );
    assert.deepEqual(new ThemeStorage(directory).read('alpha').values.windows, [{ x: 12, y: 30 }]);
    assert.deepEqual(store.read('beta').values, {});
    assert.throws(
      () => store.request('alpha', { operation: 'set', key: 'windows', value: [], revision: 0 }),
      /conflict/,
    );
    assert.deepEqual(store.read('alpha').values.windows, [{ x: 12, y: 30 }]);
    assert.deepEqual(events, [[1, 'renderer']]);
    off();
    for (const key of ['__proto__', 'constructor', 'prototype', 'bad\nkey', 'x'.repeat(201)])
      assert.throws(
        () => store.request('alpha', { operation: 'set', key, value: true }),
        /invalid_request/,
      );
    assert.throws(() => store.read('../alpha'), /unavailable/);
    for (const value of [
      undefined,
      NaN,
      Infinity,
      () => {},
      new Date(),
      new Map(),
      { a: undefined },
      [undefined],
      { [Symbol('key')]: 1 },
    ])
      assert.throws(() => cloneThemeStorageValue(value), /invalid_value/);
    const cycle: any = {};
    cycle.self = cycle;
    assert.throws(() => cloneThemeStorageValue(cycle), /invalid_value/);
    assert.throws(() => cloneThemeStorageValue('x'.repeat(1024 * 1024)), /too_large/);
    store.request('alpha', { operation: 'remove', key: 'windows' });
    assert.deepEqual(store.read('alpha').values, {});
    fs.writeFileSync(path.join(directory, 'broken.json'), 'broken fixture');
    assert.throws(
      () => store.request('broken', { operation: 'set', key: 'x', value: 1 }),
      /read_failed/,
    );
    assert.equal(
      fs.readFileSync(path.join(directory, 'broken.json'), 'utf8'),
      'broken fixture',
      'bad data is not overwritten',
    );
    const persisted = fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = (() => {
      throw Error('disk fixture');
    }) as any;
    try {
      assert.throws(
        () => store.request('alpha', { operation: 'set', key: 'x', value: 1 }),
        /write_failed/,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8'), persisted);
    assert.ok(fs.readdirSync(directory).every((file) => !file.endsWith('.tmp')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shared SDK hydrates without writing defaults, queues early functional edits and resets keys', async () => {
  let snapshot: ThemeStorageSnapshot = { revision: 1, values: { count: 10 } },
    writes = 0;
  const initial = deferred<ThemeStorageSnapshot>();
  let first = true;
  const client = new ThemeStorageClient(() => ({
    subscribeThemeStorage: () => () => {},
    requestThemeStorage: async (request) => {
      if (request.operation === 'read') {
        if (first) {
          first = false;
          return initial.promise;
        }
        return structuredClone(snapshot);
      }
      writes++;
      if (request.revision !== snapshot.revision) throw Error('theme_storage_conflict');
      const values = { ...snapshot.values };
      if (request.operation === 'set') values[request.key] = request.value;
      else delete values[request.key];
      snapshot = { revision: snapshot.revision + 1, values };
      return structuredClone(snapshot);
    },
  }));
  assert.equal(client.defaultValue('count', 0), 0);
  assert.equal(client.defaultValue('count', 99), 0);
  client.defaultValue('tab', 'home');
  const off = client.subscribe(() => {});
  client.set('count', (value: number) => value + 1);
  client.set('count', (value: number) => value + 1);
  initial.resolve(structuredClone(snapshot));
  await client.reload();
  assert.equal(client.getSnapshot().values.count, 12);
  assert.equal(writes, 0);
  assert.equal(await client.flush(), true);
  assert.equal(snapshot.values.count, 12);
  assert.equal(writes, 1);
  assert.equal(client.getSnapshot().dirty, false);
  client.set('count', null, true);
  assert.equal(await client.flush(), true);
  assert.equal('count' in snapshot.values, false);
  assert.equal('tab' in snapshot.values, false, 'fallbacks are not persisted');
  off();
});

test('conflicts rebase pure updates; failed writes preserve dirty edits and can retry', async () => {
  const directory = temporary();
  try {
    const store = new ThemeStorage(directory);
    let fail = false;
    const bridge = {
      requestThemeStorage: async (request: any) => {
        if (fail && request.operation !== 'read') throw Error('theme_storage_write_failed');
        return store.request('alpha', request);
      },
      subscribeThemeStorage: () => () => {},
    };
    const a = new ThemeStorageClient(() => bridge),
      b = new ThemeStorageClient(() => bridge);
    a.defaultValue('count', 0);
    b.defaultValue('count', 0);
    const offA = a.subscribe(() => {}),
      offB = b.subscribe(() => {});
    await Promise.all([a.reload(), b.reload()]);
    a.set('count', (n: number) => n + 1);
    await a.flush();
    b.set('count', (n: number) => n + 1);
    assert.equal(await b.flush(), true);
    assert.equal(store.read('alpha').values.count, 2);
    fail = true;
    b.set('count', 9);
    assert.equal(await b.flush(), false);
    assert.equal(b.getSnapshot().values.count, 9);
    assert.equal(b.getSnapshot().dirty, true);
    assert.equal(b.getSnapshot().error, 'theme_storage_write_failed');
    fail = false;
    assert.equal(await b.flush(), true);
    assert.equal(store.read('alpha').values.count, 9);
    assert.equal(b.getSnapshot().error, null);
    b.set('count', undefined);
    assert.equal(b.getSnapshot().error, 'theme_storage_invalid_value');
    assert.equal(store.read('alpha').values.count, 9);
    offA();
    offB();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('commit notifications during an in-flight write do not double-apply functional updates', async () => {
  let notify!: (snapshot: ThemeStorageSnapshot) => void;
  const ack = deferred<ThemeStorageSnapshot>();
  let writes = 0;
  const client = new ThemeStorageClient(() => ({
    subscribeThemeStorage: (listener) => {
      notify = listener;
      return () => {};
    },
    requestThemeStorage: async (request) => {
      if (request.operation === 'read') return { revision: 0, values: { count: 0 } };
      writes++;
      notify({ revision: 1, values: { count: 1 } });
      return ack.promise;
    },
  }));
  client.defaultValue('count', 0);
  const off = client.subscribe(() => {});
  await client.reload();
  client.set('count', (value: number) => value + 1);
  const flushing = client.flush();
  await tick();
  assert.equal(client.getSnapshot().values.count, 1);
  ack.resolve({ revision: 1, values: { count: 1 } });
  assert.equal(await flushing, true);
  assert.equal(client.getSnapshot().values.count, 1);
  assert.equal(writes, 1);
  off();
});
