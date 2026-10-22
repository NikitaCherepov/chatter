import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Like sync-languages: each independently packaged project needs a local copy.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'shared/message-accents.ts'), 'utf8');
const targets = [
  'message-accents.ts',
  'backend-api/src/services/message-accents.ts',
  'desktop-app/src/renderer/lib/message-accents.ts',
];
let stale = false;
for (const target of targets) {
  const filename = path.join(root, target);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n') !== source.replace(/\r\n/g, '\n')) {
      console.error(`[message-accents] stale: ${target}`);
      stale = true;
    }
  } else {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
}
if (stale) process.exitCode = 1;
else console.log('[message-accents] copies in sync');
