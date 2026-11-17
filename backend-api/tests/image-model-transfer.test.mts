import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-image-model-transfer-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'image-transfer-test-only';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENROUTER_BASE_URL = '';
for (const key of Object.keys(process.env).filter(key => key.startsWith('TIMEWEB_') || key === 'MODELS_MANUAL'))
  process.env[key] = '';

const { db } = await import('../src/db.js');
const { exportModelConfig, importModelConfig, parseModelConfig } = await import('../src/services/model-config-transfer.js');
const { importModelKey, modelApiKey, updateModelSettings, getModelSettings } = await import('../src/services/model-settings.js');
const { getImageGenerationSettings, updateImageGenerationSettings } = await import('../src/services/image-generation-settings.js');
const { getModelOverride } = await import('../src/services/token-quota.js');

try {
  const sharedKey = importModelKey('Shared text and image key', 'shared-image-test-key');
  const cloudflareKey = importModelKey('Cloudflare token', 'cloudflare-image-test-token');
  updateModelSettings({
    proModels: [{ id: 'text', uniqueId: 'text', model: 'text-model', baseUrl: 'https://example.test/v1', apiKeyId: sharedKey }],
    liteModels: [], manualModels: [], visionModel: { id: 'vision', uniqueId: 'vision', model: '', baseUrl: '', apiKeyId: null },
  });
  const original = updateImageGenerationSettings({
    enabled: true, provider: 'cloudflare', img2imgEnabled: false,
    openrouter: {
      apiKeyId: sharedKey, baseUrl: 'https://images.example.test/v1',
      model: { id: 'vendor/image-model', name: 'Custom image model', capabilities: { input_references: true },
        params: { resolution: { allowed: ['1K', '2K'], default: '1K' }, quality: null,
          aspectRatio: { allowed: ['1:1', '16:9'], default: '16:9' } } },
    },
    cloudflare: {
      apiTokenId: cloudflareKey, accountId: 'test-cloudflare-account',
      model: { id: '@cf/vendor/image-model', name: 'Custom Cloudflare image',
        params: { quality: { allowed: ['low', 'high'], default: 'high' } } },
    },
  });

  const exported = exportModelConfig(true);
  const noSecrets = exportModelConfig(false);
  assert.equal(exported.keys.length, 2, 'the shared text and image key is exported once');
  assert.equal(exported.imageGeneration!.openrouter.keyRef, exported.models[0].keyRef);
  assert.equal(exported.imageGeneration!.openrouter.apiKeyId, null);
  assert.equal(exported.imageGeneration!.cloudflare.apiTokenId, null);
  assert.equal(JSON.stringify(exported.imageGeneration).includes('shared-image-test-key'), false);
  assert.equal(JSON.stringify(noSecrets).includes('shared-image-test-key'), false);
  assert.equal(JSON.stringify(noSecrets).includes('cloudflare-image-test-token'), false);
  assert.ok(noSecrets.keys.every(key => key.key === undefined));
  assert.deepEqual(exported.imageGeneration!.openrouter.model.params, original.openrouter.model.params);

  const parsed = parseModelConfig([{ name: 'models.json', data: Buffer.from(JSON.stringify(exported)) }]);
  db.exec('DELETE FROM api_keys; DELETE FROM model_overrides;');
  db.prepare("DELETE FROM system_settings WHERE key IN ('ai_model_settings_v1','image_generation_settings')").run();
  const occupied = importModelKey('Unrelated existing key', 'keep-existing-test-key', sharedKey);
  assert.equal(occupied, sharedKey);
  const result = importModelConfig(parsed);
  assert.equal(result.added, 2, 'text and image settings are imported');
  const restored = getImageGenerationSettings();
  assert.deepEqual({ ...restored, openrouter: { ...restored.openrouter, apiKeyId: original.openrouter.apiKeyId },
    cloudflare: { ...restored.cloudflare, apiTokenId: original.cloudflare.apiTokenId } }, original);
  assert.notEqual(restored.openrouter.apiKeyId, sharedKey, 'a key ID collision is remapped');
  assert.equal(restored.openrouter.apiKeyId, getModelSettings().proModels[0].apiKeyId);
  assert.equal(modelApiKey(occupied), 'keep-existing-test-key');
  assert.equal(importModelConfig(parsed).added, 0, 'reimporting is idempotent');

  const imagesOnly = { ...noSecrets, models: [], imageGeneration: {
    ...noSecrets.imageGeneration!,
    openrouter: { ...noSecrets.imageGeneration!.openrouter, keyRef: undefined, apiKeyId: restored.openrouter.apiKeyId },
    cloudflare: { ...noSecrets.imageGeneration!.cloudflare, keyRef: undefined, apiTokenId: restored.cloudflare.apiTokenId },
  } };
  assert.equal(importModelConfig(imagesOnly).added, 0, 'existing vault keys can be selected without exporting secrets');
  const beforeFailure = getImageGenerationSettings();
  const beforeTextModels = getModelSettings();
  const keyCount = () => (db.prepare('SELECT count(*) AS n FROM api_keys').get() as { n: number }).n;
  const beforeKeyCount = keyCount();
  assert.throws(() => importModelConfig({ ...exported, models: [{
    ...exported.models[0], id: 'rollback-text', uniqueId: 'rollback-text', model: 'rollback-text',
    billing: { coefficient: 2, inputPricePerMillion: 1 },
  }], keys: [
    { id: exported.imageGeneration!.openrouter.keyRef!, name: 'Rollback key', key: 'rollback-test-key' },
  ] }), /api_key_required/);
  assert.deepEqual(getImageGenerationSettings(), beforeFailure);
  assert.deepEqual(getModelSettings(), beforeTextModels);
  assert.equal(getModelOverride('rollback-text'), null, 'rolled-back pricing is removed from the runtime cache');
  assert.equal(keyCount(), beforeKeyCount, 'a missing provider key rolls back keys and settings together');
  assert.throws(() => parseModelConfig([{ name: 'bad.json', data: Buffer.from(JSON.stringify({
    ...exported, imageGeneration: { ...exported.imageGeneration, provider: 'invalid' },
  })) }]), /invalid_image_model_config/);
  assert.throws(() => importModelConfig({ ...imagesOnly, imageGeneration: {
    ...imagesOnly.imageGeneration, cloudflare: { ...imagesOnly.imageGeneration.cloudflare, apiTokenId: 999999 },
  } }), /api_key_not_found/);
  assert.deepEqual(getImageGenerationSettings(), beforeFailure);
  importModelConfig({ format: 'chatter-models', version: 1, models: [], keys: [], warnings: [] });
  assert.deepEqual(getImageGenerationSettings(), beforeFailure, 'legacy exports do not change image settings');
  console.log('PASS: image model export/import, both providers, parameters, shared keys, ID remapping, no-secret exports, rollback and legacy files');
} finally {
  db.close();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('chatter-image-model-transfer-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
