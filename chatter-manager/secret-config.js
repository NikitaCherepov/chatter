'use strict';
const BACKEND_SECRETS = ['API_JWT_SECRET', 'BACKEND_INTERNAL_TOKEN', 'ENCRYPTION_KEY', 'DEVOPS_ENCRYPTION_KEY', 'MAP_PINS_ENCRYPTION_KEY'];
function containerEnvironment(values) {
  return Object.fromEntries(values.map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
}
function assertSecretEnvironment(expected, actual, keys = BACKEND_SECRETS) {
  if (keys.some(name => `${expected[name] || ''}` !== `${actual[name] || ''}`)) throw new Error('running_secret_config_mismatch');
}
module.exports = { BACKEND_SECRETS, containerEnvironment, assertSecretEnvironment };
