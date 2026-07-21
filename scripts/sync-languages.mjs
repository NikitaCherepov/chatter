#!/usr/bin/env node
/**
 * sync-languages.mjs
 *
 * Copies `shared/languages.ts` (the canonical source of truth) into every
 * server-side project's local i18n folder.  Run automatically via the
 * `sync:languages` npm script, which is wired as a prebuild/predev hook
 * for every consumer project.
 *
 * Why a sync script instead of a single shared file?
 *   - Each project's tsconfig has `rootDir: src/` (backend-api) or an
 *     `include` scoped to its own folder (Next.js projects).  Importing
 *     `../../shared/languages` from outside the root breaks compilation.
 *   - The desktop app needs a fully isolated copy (ships to users).
 *   - A sync script gives us a single source of truth *and* preserves
 *     project isolation.
 *
 * Usage:
 *   node scripts/sync-languages.mjs           # write local copies
 *   node scripts/sync-languages.mjs --check   # exit 1 if any local copy is stale (for CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SOURCE = path.join(projectRoot, 'shared/languages.ts');

// Projects that consume the shared language list.
// Desktop app is intentionally excluded — it ships offline to users and
// keeps its own copy at desktop-app/src/renderer/i18n/languages.ts.
const TARGETS = [
  'i18n/languages.ts',                                        // Telegram bot
  'admin-panel/i18n/languages.ts',                            // admin panel (Next.js)
  'backend-api/src/i18n/languages.ts',                        // backend API
  'webapp-notes/i18n/languages.ts',                           // webapp notes (Next.js)
];

const checkOnly = process.argv.includes('--check');

if (!fs.existsSync(SOURCE)) {
  console.error(`[sync-languages] Source not found: ${SOURCE}`);
  process.exit(1);
}

const sourceContent = fs.readFileSync(SOURCE, 'utf8');

let stale = 0;
let written = 0;

for (const relativeTarget of TARGETS) {
  const target = path.join(projectRoot, relativeTarget);
  const dir = path.dirname(target);

  if (checkOnly) {
    if (!fs.existsSync(target)) {
      console.error(`[sync-languages] MISSING: ${relativeTarget}`);
      stale++;
    } else {
      const current = fs.readFileSync(target, 'utf8');
      if (current !== sourceContent) {
        console.error(`[sync-languages] STALE: ${relativeTarget}`);
        stale++;
      }
    }
    continue;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, sourceContent, 'utf8');
  console.log(`[sync-languages] wrote ${relativeTarget}`);
  written++;
}

if (checkOnly) {
  if (stale > 0) {
    console.error(`\n[sync-languages] ${stale} target(s) out of sync. Run "npm run sync:languages" and commit the result.`);
    process.exit(1);
  }
  console.log('[sync-languages] all targets in sync.');
} else {
  console.log(`\n[sync-languages] synced ${written} target(s) from shared/languages.ts.`);
}
