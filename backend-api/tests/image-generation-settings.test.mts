import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-image-gen-settings-'));
process.env.API_DB_PATH = path.join(tempDir, 'image-gen-settings.db');

// Seed env vars must be set BEFORE the module is imported.
process.env.OPENROUTER_API_KEY = 'seed-or-key';
process.env.OPENROUTER_BASE_URL = '';
delete process.env.IMAGE_GEN_MODEL;
delete process.env.IMAGE_GEN_MAX_RESOLUTION;
delete process.env.IMAGE_GEN_QUALITY;
delete process.env.IMAGE_GEN_SUPPORTED_PARAMETERS;

const { db } = await import('../src/db.js');
const {
  getImageGenerationSettings,
  updateImageGenerationSettings,
} = await import('../src/services/image-generation-settings.js');

// ── 1. Legacy enabled toggle is carried over into the seed ─────────────────
db.prepare(`
  INSERT INTO system_settings (key, value_json, updated_at)
  VALUES ('image_generation_enabled', 'false', 0)
`).run();

let settings = getImageGenerationSettings();

assert.equal(settings.enabled, false, 'legacy enabled=false must carry into the seed');
assert.equal(settings.provider, 'openrouter');
assert.equal(settings.openrouter.apiKey, 'seed-or-key');
assert.equal(settings.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
assert.equal(settings.openrouter.model.id, 'x-ai/grok-imagine-image-quality');
assert.equal(settings.img2imgEnabled, true, 'default supported params include input_references');
assert.deepEqual(
  settings.openrouter.model.params.resolution,
  { allowed: ['2K'], default: '2K' },
  'resolution seeded from the env default',
);
assert.equal(settings.openrouter.model.params.quality, null, 'quality not in default supported params');
assert.equal(settings.openrouter.model.params.aspectRatio.default, 'auto');
assert.ok(settings.openrouter.model.params.aspectRatio.allowed.length >= 20, 'all ratios allowed by default');

const legacyRow = db.prepare(
  "SELECT value_json FROM system_settings WHERE key = 'image_generation_enabled'"
).get();
assert.equal(legacyRow, undefined, 'legacy key must be removed after the seed');

// ── 2. Legacy flat panel payload (what the admin panel sends today) ────────
settings = updateImageGenerationSettings({
  enabled: true,
  apiKey: '', // empty = keep the stored key
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'vendor/model-x',
  maxResolution: '1K',
  quality: 'high',
  supportedParameters: ['resolution', 'input_references'],
});

assert.equal(settings.enabled, true);
assert.equal(settings.openrouter.apiKey, 'seed-or-key', 'empty apiKey keeps the stored key');
assert.equal(settings.openrouter.model.id, 'vendor/model-x');
assert.deepEqual(settings.openrouter.model.params.resolution, { allowed: ['1K'], default: '1K' });
assert.equal(settings.openrouter.model.params.quality, null, 'quality dropped from supportedParameters');
assert.equal(settings.img2imgEnabled, true);

// ── 3. Legacy flat payload with a NEW key (secret merge) ───────────────────
settings = updateImageGenerationSettings({ apiKey: 'fresh-key' });
assert.equal(settings.openrouter.apiKey, 'fresh-key');

// ── 4. Nested runtime patch (future panel contract) ────────────────────────
settings = updateImageGenerationSettings({
  openrouter: {
    apiKey: '', // keep
    model: {
      id: 'vendor/model-y',
      params: {
        quality: { allowed: ['low', 'high'], default: 'high' },
        aspectRatio: { allowed: ['auto', '1:1', '16:9'], default: 'bogus' },
      },
    },
  },
});

assert.equal(settings.openrouter.apiKey, 'fresh-key', 'nested empty apiKey keeps the key');
assert.equal(settings.openrouter.model.id, 'vendor/model-y');
assert.deepEqual(settings.openrouter.model.params.quality, { allowed: ['low', 'high'], default: 'high' });
assert.deepEqual(
  settings.openrouter.model.params.aspectRatio,
  { allowed: ['auto', '1:1', '16:9'], default: 'auto' },
  'invalid default falls back to auto, unknown ratios filtered',
);

// ── 5. Unknown provider is rejected ────────────────────────────────────────
assert.throws(() => updateImageGenerationSettings({ provider: 'cloudflare' }), /unsupported image generation provider/);

// ── 6. Toggle-only patch (the panel's enabled switch) ──────────────────────
settings = updateImageGenerationSettings({ enabled: false });
assert.equal(settings.enabled, false);
assert.equal(settings.openrouter.model.id, 'vendor/model-y', 'rest of settings untouched');

console.log('image-generation settings migration and updates: ok');
