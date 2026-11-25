import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url),
  desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(desktop, 'tests/chat-sdk.electron.cjs')], {
  cwd: desktop,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
const code = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    output += '\nChat SDK Electron timeout\n';
    child.kill();
  }, 60000);
  child.once('exit', (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
  child.once('error', reject);
});
process.stdout.write(output);
assert.equal(code, 0);
