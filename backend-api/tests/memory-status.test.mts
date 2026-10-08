import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-memory-status-${process.pid}-${Date.now()}.sqlite`);
process.env.ENCRYPTION_KEY = 'memory-status-test-only';
process.env.TIMEWEB_API_KEY = '';
process.env.TIMEWEB_EMBED_API_KEY = '';
const { db } = await import('../src/db.js');
const { getEncryptionKey } = await import('../src/utils/encryption.js');
const { isVectorMemoryConfigured, updateVectorMemorySettings } = await import('../src/services/vector-memory-settings.js');
try {
  assert.equal(isVectorMemoryConfigured(), false, 'no embedding key means not configured');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const secret = Buffer.concat([cipher.update('test-provider-key'), cipher.final()]);
  const id = Number(db.prepare('INSERT INTO api_keys (name, key_encrypted, key_prefix) VALUES (?, ?, ?)').run('Test', `${iv.toString('hex')}::${secret.toString('hex')}`, 'test').lastInsertRowid);
  updateVectorMemorySettings({ apiKeyId: id });
  assert.equal(isVectorMemoryConfigured(), true, 'embedding model with usable key is configured without network calls');
  db.prepare('UPDATE api_keys SET key_encrypted = ? WHERE id = ?').run('invalid-ciphertext', id);
  assert.equal(isVectorMemoryConfigured(), false, 'unreadable key is not usable');
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  assert.equal(isVectorMemoryConfigured(), false, 'deleted key is not usable');
  console.log('memory configuration readiness tests passed');
} finally { db.close(); }
