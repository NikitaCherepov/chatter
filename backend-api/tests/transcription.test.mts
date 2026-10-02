import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-transcription-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
process.env.ENCRYPTION_KEY = 'transcription-test-key';

const { db } = await import('../src/db.js');
const {
  getTranscriptionSettings,
  replaceTranscriptionApiKeyReference,
  updateTranscriptionSettings,
} = await import('../src/services/transcription-settings.js');
const { getTranscriptionStatus, transcribeAudio } =
  await import('../src/services/transcription.js');

db.prepare(
  "INSERT INTO users (id, name, role, is_admin, status, plan) VALUES (501, 'Voice admin', 'admin', 1, 'approved', 'pro')",
).run();

const secret = 'test-provider-key';
const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv(
  'aes-256-cbc',
  crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest(),
  iv,
);
const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
const keyId = Number(
  db
    .prepare('INSERT INTO api_keys (name, key_encrypted, key_prefix) VALUES (?, ?, ?)')
    .run('Transcription test', `${iv.toString('hex')}::${encrypted.toString('hex')}`, 'test…key')
    .lastInsertRowid,
);

const configured = updateTranscriptionSettings({
  enabled: true,
  provider: 'custom',
  baseUrl: 'https://voice.example/v1',
  model: 'test-transcriber',
  apiKeyId: keyId,
  audioPricePerSecond: 0.0001,
  inputPricePerMillion: 0.2,
});
assert.equal(configured.hasApiKey, true);
assert.equal(configured.model, 'test-transcriber');

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method: string }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = `${input}`;
  const method = init?.method || 'GET';
  requests.push({ url, method });
  if (method === 'GET') {
    return new Response(JSON.stringify({ data: [{ id: 'test-transcriber' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  assert.equal(
    init?.headers && (init.headers as Record<string, string>).Authorization,
    `Bearer ${secret}`,
  );
  assert.ok(init?.body instanceof FormData);
  assert.equal((init.body as FormData).get('model'), 'test-transcriber');
  assert.equal((init.body as FormData).get('language'), 'ru');
  return new Response(
    JSON.stringify({
      text: 'Проверка распознавания',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, cost: 0.0012 },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}) as typeof fetch;

const status = await getTranscriptionStatus(true);
assert.equal(status.available, true);
assert.equal(requests[0].url, 'https://voice.example/v1/models');

const wav = Buffer.alloc(44 + 32_000);
wav.write('RIFF', 0, 'ascii');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVE', 8, 'ascii');
wav.write('fmt ', 12, 'ascii');
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36, 'ascii');
wav.writeUInt32LE(32_000, 40);

const result = await transcribeAudio({ userId: 501, audioBuffer: wav, language: 'ru-RU' });
assert.equal(result.text, 'Проверка распознавания');
assert.equal(requests[1].url, 'https://voice.example/v1/audio/transcriptions');

const usage = db
  .prepare(
    `
  SELECT route, model_id, provider_name, total_tokens, actual_cost_usd, pricing_source
  FROM user_token_usage WHERE user_id = 501 ORDER BY id DESC LIMIT 1
`,
  )
  .get() as any;
assert.deepEqual(usage, {
  route: 'voice:transcription',
  model_id: 'test-transcriber',
  provider_name: 'custom',
  total_tokens: 6,
  actual_cost_usd: 0.0012,
  pricing_source: 'provider_reported',
});

replaceTranscriptionApiKeyReference(keyId, null);
assert.equal(getTranscriptionSettings().apiKeyId, null);

globalThis.fetch = originalFetch;
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(`${dbPath}${suffix}`);
  } catch {
    /* already absent */
  }
}
console.log('transcription tests passed');
