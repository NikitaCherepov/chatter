import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [name, directory] of ['appearance', 'chat-layout'].flatMap(name => [
  [name, 'backend-api/src/services'],
  [name, 'desktop-app/src/renderer/lib'],
])) {
  const source = fs.readFileSync(path.join(root, 'shared', name + '.ts'), 'utf8');
  const target = path.join(directory, name + '-schema.ts');
  const file = path.join(root, target);
  if (process.argv.includes('--check')) {
    if (
      !fs.existsSync(file) ||
      fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== source.replace(/\r\n/g, '\n')
    ) {
      console.error('Stale shared schema: ' + target);
      process.exitCode = 1;
    }
  } else fs.writeFileSync(file, source);
}
for (const directory of ['backend-api/src/services', 'desktop-app/src/renderer/lib', 'desktop-app/src/main']) {
  const source = fs.readFileSync(path.join(root, 'shared/appearance-project.ts'), 'utf8');
  const target = path.join(root, directory, 'appearance-project.ts');
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== source.replace(/\r\n/g, '\n')) {
      console.error('Stale shared project contract: ' + target);
      process.exitCode = 1;
    }
  } else fs.writeFileSync(target, source);
}
