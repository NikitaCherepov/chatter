const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BACKEND_SECRETS, containerEnvironment, assertSecretEnvironment } = require('./secret-config');
test('running env preserves equals signs and exact secret values', () => {
  assert.deepEqual(containerEnvironment(['ENCRYPTION_KEY=test=only=', 'EMPTY=']), { ENCRYPTION_KEY: 'test=only=', EMPTY: '' });
});
test('matching Compose/file values are insufficient when the actual container differs', () => {
  const file = { API_JWT_SECRET: 'jwt', BACKEND_INTERNAL_TOKEN: 'internal', ENCRYPTION_KEY: 'manager-key' };
  const compose = { ...file };
  assert.doesNotThrow(() => assertSecretEnvironment(file, compose));
  const running = { ...file, ENCRYPTION_KEY: 'repository-key' };
  assert.throws(() => assertSecretEnvironment(file, running), /^Error: running_secret_config_mismatch$/);
});
test('every backend secret, including fallback overrides, is checked without exposing it', () => {
  const expected = Object.fromEntries(BACKEND_SECRETS.map(name => [name, 'test-only']));
  for (const name of BACKEND_SECRETS) {
    assert.throws(() => assertSecretEnvironment(expected, { ...expected, [name]: 'other-test-only' }), error => !error.message.includes('test-only'));
  }
  assert.doesNotThrow(() => assertSecretEnvironment({ ENCRYPTION_KEY: 'same' }, { ENCRYPTION_KEY: 'same' }));
});
test('dependent service checks do not require unused JWT/encryption settings', () => {
  assert.doesNotThrow(() => assertSecretEnvironment({ BACKEND_INTERNAL_TOKEN: 'same' }, { BACKEND_INTERNAL_TOKEN: 'same', ENCRYPTION_KEY: 'different' }, ['BACKEND_INTERNAL_TOKEN']));
});
