'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const collectionPattern = /^[a-zA-Z0-9_-]{1,120}$/;
const snapshotPattern = /^qdrant\/[a-f0-9]{64}\.snapshot$/;

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateQdrantBackup(directory, manifest) {
  if (manifest === undefined) return;
  if (!manifest || !Array.isArray(manifest.collections) || manifest.collections.length > 1000)
    throw new Error('Invalid Qdrant backup manifest');
  const names = new Set();
  const files = new Set();
  for (const entry of manifest.collections) {
    if (!entry || typeof entry.name !== 'string' || !collectionPattern.test(entry.name) || !snapshotPattern.test(entry.file) ||
        names.has(entry.name) || files.has(entry.file) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0)
      throw new Error('Invalid Qdrant backup collection');
    names.add(entry.name);
    files.add(entry.file);
    const file = path.join(directory, entry.file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== entry.size || await digest(file) !== entry.sha256)
      throw new Error(`Qdrant snapshot integrity check failed for ${entry.name}`);
  }
  const absent = manifest.absentCollections ?? [];
  if (!Array.isArray(absent) || absent.length > 1000) throw new Error('Invalid Qdrant backup manifest');
  for (const name of absent) {
    if (typeof name !== 'string' || !collectionPattern.test(name) || names.has(name))
      throw new Error('Invalid absent Qdrant collection');
    names.add(name);
  }
}

function createQdrantBackup({ url, apiKey = '', fetchImpl = fetch }) {
  const base = new URL(url);
  async function request(endpoint, options = {}) {
    const response = await fetchImpl(new URL(base.href.replace(/\/$/, '') + endpoint), {
      ...options,
      headers: { ...(apiKey ? { 'api-key': apiKey } : {}), ...options.headers },
      signal: AbortSignal.timeout(60 * 60 * 1000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Qdrant backup request failed (HTTP ${response.status})`);
    }
    return response;
  }
  const jsonRequest = async (endpoint, options) => {
    const body = await (await request(endpoint, options)).json();
    if (body.status !== 'ok') throw new Error('Qdrant backup operation failed');
    return body.result;
  };
  const collectionPath = name => `/collections/${encodeURIComponent(name)}`;

  async function capture(directory, names) {
    if (names.some(name => typeof name !== 'string' || !collectionPattern.test(name)))
      throw new Error('Invalid Qdrant collection name');
    if (!names.length) return { collections: [], absentCollections: [] };
    const available = new Set((await jsonRequest('/collections')).collections.map(item => item.name));
    const collections = [];
    fs.mkdirSync(path.join(directory, 'qdrant'), { recursive: true, mode: 0o700 });
    for (const name of new Set(names)) {
      if (!available.has(name)) continue;
      const endpoint = collectionPath(name) + '/snapshots';
      const snapshot = await jsonRequest(endpoint + '?wait=true', { method: 'POST' });
      if (typeof snapshot?.name !== 'string' || !snapshot.name)
        throw new Error('Qdrant did not return a snapshot name');
      try {
        const file = 'qdrant/' + crypto.createHash('sha256').update(name).digest('hex') + '.snapshot';
        const destination = path.join(directory, file);
        const response = await request(endpoint + '/' + encodeURIComponent(snapshot.name));
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { mode: 0o600 }));
        const size = fs.statSync(destination).size;
        if (!size) throw new Error(`Qdrant returned an empty snapshot for ${name}`);
        collections.push({ name, file, size, sha256: await digest(destination) });
      } finally {
        await jsonRequest(endpoint + '/' + encodeURIComponent(snapshot.name) + '?wait=true', { method: 'DELETE' });
      }
    }
    return { collections, absentCollections: [...new Set(names)].filter(name => !available.has(name)) };
  }

  async function restore(directory, manifest) {
    await validateQdrantBackup(directory, manifest);
    for (const entry of manifest.collections) {
      const boundary = 'chatter-' + crypto.randomUUID();
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="snapshot"; filename="memory.snapshot"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const file = path.join(directory, entry.file);
      async function* multipart() {
        yield header;
        yield* fs.createReadStream(file);
        yield footer;
      }
      const result = await jsonRequest(collectionPath(entry.name) + '/snapshots/upload?wait=true&priority=snapshot&checksum=' + entry.sha256, {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': String(header.length + entry.size + footer.length),
        },
        body: Readable.from(multipart()),
        duplex: 'half',
      });
      if (result !== true) throw new Error(`Qdrant did not restore ${entry.name}`);
    }
    if (manifest.absentCollections?.length) {
      const current = new Set((await jsonRequest('/collections')).collections.map(entry => entry.name));
      for (const name of manifest.absentCollections)
        if (current.has(name)) await jsonRequest(collectionPath(name) + '?wait=true', { method: 'DELETE' });
    }
  }
  return { capture, restore };
}

module.exports = { createQdrantBackup, validateQdrantBackup, snapshotPattern };
