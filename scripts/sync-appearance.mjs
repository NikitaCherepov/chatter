import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'shared/appearance.ts'), 'utf8');
for (const target of [
  'backend-api/src/services/appearance-schema.ts',
  'desktop-app/src/renderer/lib/appearance-schema.ts',
]) {
  const file = path.join(root, target);
  if (process.argv.includes('--check')) {
    if (
      !fs.existsSync(file) ||
      fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== source.replace(/\r\n/g, '\n')
    ) {
      console.error('Stale appearance schema: ' + target);
      process.exitCode = 1;
    }
  } else fs.writeFileSync(file, source);
}
