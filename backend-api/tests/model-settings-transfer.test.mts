import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-model-settings-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(directory, 'uploads');
process.env.ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret';
process.env.TIMEWEB_BASE_URL = 'https://example.test/v1';
process.env.TIMEWEB_API_KEY = 'test-secret-original';
process.env.TIMEWEB_MODEL = 'model-one';
process.env.TIMEWEB_PRO_ENDPOINTS = 'https://example.test/v1|test-secret-original|model-one,model-two|stable-one,stable-two|';
process.env.TIMEWEB_LITE_ENDPOINTS = 'https://example.test/v1|test-secret-original|model-lite|stable-lite|';
process.env.MODELS_MANUAL = 'https://example.test/v1|test-secret-original|model-manual|Manual|Description|stable-manual|1|0||0';
process.env.TIMEWEB_VISION_MODEL = 'vision-one';
process.env.TIMEWEB_VISION_API_KEY = '';
process.env.TIMEWEB_VISION_BASE_URL = '';
process.env.TIMEWEB_LITE_VISION_MODEL = '';
process.env.TIMEWEB_LITE_VISION_BASE_URL = '';
process.env.TIMEWEB_LITE_VISION_API_KEY = '';
process.env.TIMEWEB_VISION_UNIQUE_ID = 'stable-vision';
process.env.TIMEWEB_MODEL_SUPPORTS_VISION = '1';
const { db } = await import('../src/db.js');
const settings = await import('../src/services/model-settings.js');
const transfer = await import('../src/services/model-config-transfer.js');
const { setModelProvider, getModelOverride, refreshCoefficientCache } = await import('../src/services/token-quota.js');
try {
  const initial = settings.getModelSettings();
  assert.deepEqual(initial.proModels.map(m => m.uniqueId), ['stable-one', 'stable-two']);
  assert.equal(initial.manualModels[0].supportsTools, false);
  assert.equal(initial.manualModels[0].supportsVision, true);
  assert.equal(initial.visionModel.uniqueId, 'stable-vision');
  assert.equal(db.prepare('SELECT count(*) AS n FROM api_keys').get().n, 1);
  assert.ok(!JSON.stringify(initial).includes('test-secret-original'));
  assert.equal(settings.modelApiKey(initial.proModels[0].apiKeyId), 'test-secret-original');
  assert.equal(settings.publicModelSettings().proModels[0].apiKey, '');
  process.env.TIMEWEB_MODEL = 'old-env-must-not-return';
  assert.equal(settings.getModelSettings().proModels[0].model, 'model-one');
  setModelProvider('stable-one', { providerKind: 'openrouter', openrouterProviderSlug: 'deepinfra', coefficient: 1.3, pricingMode: 'manual', inputPricePerMillion: 0.9, outputPricePerMillion: 1.8, contextLength: 120000 });
  const exported = transfer.exportModelConfig(true);
  assert.equal(exported.keys[0].key, 'test-secret-original');
  assert.equal(exported.models[0].billing.inputPricePerMillion, 0.9);
  assert.equal(transfer.exportModelConfig(false).keys[0].key, undefined);
  const read = transfer.parseModelConfig([{ name: 'models.json', data: Buffer.from(JSON.stringify(exported)) }]);
  assert.deepEqual(transfer.importModelConfig(read), { added: 0, skipped: 5 });
  assert.equal(settings.getModelSettings().proModels.length, 2);
  assert.equal(getModelOverride('stable-one').openrouter_provider_slug, 'deepinfra');
  const collision = { format: 'chatter-models', version: 1, warnings: [], keys: [{ id: 'imported', sourceId: initial.proModels[0].apiKeyId, name: 'Different key', key: 'test-different-key' }],
    models: [{ id: initial.proModels[0].id, uniqueId: 'stable-one', baseUrl: 'https://other.test/v1', model: 'other-model', apiKeyId: null, keyRef: 'imported', roles: ['pro', 'manual'], billing: { inputPricePerMillion: 3.5, coefficient: 2 } }] };
  const added = transfer.importModelConfig(collision);
  assert.equal(added.added, 2);
  const imported = settings.getModelSettings().proModels.at(-1);
  assert.notEqual(imported.uniqueId, 'stable-one');
  assert.notEqual(imported.id, initial.proModels[0].id);
  assert.notEqual(imported.apiKeyId, initial.proModels[0].apiKeyId);
  assert.equal(getModelOverride(imported.uniqueId).input_price_per_million, 3.5);
  assert.equal(getModelOverride('stable-one').input_price_per_million, 0.9);
  assert.equal(transfer.importModelConfig(collision).added, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM api_keys').get().n, 2);
  const beforeFailure = JSON.stringify(settings.getModelSettings());
  assert.throws(() => transfer.importModelConfig({ ...collision, keys: [{ id: 'imported', name: 'Rollback key', key: 'rollback-secret-key' }], models: [{ ...collision.models[0], baseUrl: 'not-a-url' }] }));
  assert.equal(JSON.stringify(settings.getModelSettings()), beforeFailure);
  assert.equal(db.prepare('SELECT count(*) AS n FROM api_keys').get().n, 2);
  assert.throws(() => transfer.importModelConfig({ ...collision, models: [{ ...collision.models[0], billing: { inputPricePerMillion: -1 } }] }));
  assert.throws(() => settings.updateModelSettings({ manualModels: [{ ...initial.manualModels[0], apiKeyId: 99999 }] }));
  const st = { extension_settings: { connectionManager: { profiles: [
    { id: 'profile-one', mode: 'cc', api: 'openrouter', model: 'test/model', 'secret-id': 'st-key' },
    { id: 'tc', mode: 'tc', api: 'textgenerationwebui', model: 'skip-me' },
  ] } }, oai_settings: { chat_completion_source: 'openrouter', openrouter_model: 'test/model' } };
  const zip = Buffer.from(zipSync({
    'data/default-user/settings.json': strToU8(JSON.stringify(st)),
    'data/default-user/secrets.json': strToU8(JSON.stringify({ api_key_openrouter: [{ id: 'st-key', label: 'Test ST key', value: 'test-st-secret', active: true }] })),
    'data/default-user/chats/ignored.jsonl': strToU8('Ignored history'),
  }));
  const stPreview = await transfer.parseModelArchive(Readable.from([zip]));
  assert.equal(stPreview.models.length, 1);
  assert.equal(stPreview.models[0].baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(stPreview.keys[0].key, 'test-st-secret');
  assert.ok(stPreview.warnings.includes('st_text_completion_not_supported'));
  assert.equal(fs.readdirSync(path.join(directory, 'uploads', '.model-config-imports')).length, 0);
  const withoutKeys = await transfer.parseModelArchive(Readable.from([Buffer.from(zipSync({ 'settings.json': strToU8(JSON.stringify(st)) }))]));
  assert.equal(withoutKeys.keys.length, 1);
  assert.equal(withoutKeys.keys[0].key, undefined);
  assert.throws(() => transfer.importModelConfig(withoutKeys), /api_key_required/);
  const attachExisting = { ...withoutKeys, models: withoutKeys.models.map(m => ({ ...m, keyRef: undefined, apiKeyId: initial.proModels[0].apiKeyId })) };
  assert.equal(transfer.importModelConfig(attachExisting).added, 1);
  assert.throws(() => transfer.parseModelConfig([{ name: 'a/settings.json', data: Buffer.from(JSON.stringify(st)) }, { name: 'b/settings.json', data: Buffer.from(JSON.stringify(st)) }]));
  assert.throws(() => transfer.parseModelConfig([{ name: 'bad.json', data: Buffer.from('{') }]));
  settings.updateModelSettings({ proModels: [] });
  assert.equal(settings.getModelSettings().proModels.length, 0);
  assert.equal(settings.getModelSettings().proModels.length, 0, 'stale env must not restore deleted models');
  db.prepare('DELETE FROM system_settings WHERE key = ?').run('ai_model_settings_v1');
  db.exec('DELETE FROM model_overrides; DELETE FROM api_keys;');
  refreshCoefficientCache();
  for (const key of Object.keys(process.env).filter(key => key.startsWith('TIMEWEB_') || key === 'MODELS_MANUAL')) process.env[key] = '';
  assert.equal(settings.getModelSettings().proModels.length, 0);
  const fresh = transfer.importModelConfig(exported);
  assert.equal(fresh.added, 5);
  const restored = settings.getModelSettings();
  assert.deepEqual(restored.proModels.map(m => m.uniqueId), initial.proModels.map(m => m.uniqueId));
  assert.deepEqual(restored.proModels.map(m => m.id), initial.proModels.map(m => m.id));
  assert.equal(restored.proModels[0].apiKeyId, initial.proModels[0].apiKeyId);
  assert.equal(getModelOverride('stable-one').input_price_per_million, 0.9);
  assert.equal(restored.manualModels[0].supportsTools, false);
  assert.equal(restored.visionModel.model, 'vision-one');
  assert.equal(restored.proSupportsVision, true);
  console.log('model-settings-transfer tests passed');
} finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
