import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LocalAppearanceStore } = require('../src/main/local-appearance');
const { newAppearance } = require('../src/main/appearance-schema');
const {
  parseAppearanceProject,
  isAppearanceAssetPath,
  APPEARANCE_ASSET_LIMITS,
} = require('../src/main/appearance-project');
import ts from 'typescript';
test('local binary assets survive publication, rollback and portable import', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-assets-'));
  try {
    const store = new LocalAppearanceStore(path.join(root, 'one'));
    const profile = {
      ...newAppearance('assets-test'),
      shell: {
        version: 1,
        language: 'tsx',
        scope: 'workspace',
        entry: 'App.tsx',
        files: { 'App.tsx': 'export default function App(){return null}' },
      },
    } as any;
    store.writeDraft(profile);
    const draft = path.join(store.directory, '.drafts', profile.id);
    fs.mkdirSync(path.join(draft, 'assets'));
    fs.writeFileSync(path.join(draft, 'assets/click.wav'), Buffer.from('RIFF-test'));
    const first = store.readDraft(profile.id),
      url = first.shell!.assets!['assets/click.wav'];
    assert.equal(store.readAsset(url).mimeType, 'audio/wav');
    assert.equal(store.readAsset(url).data.toString(), 'RIFF-test');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(draft, 'theme.json'), 'utf8')).shell.assets,
      undefined,
    );
    store.save(first, true);
    fs.writeFileSync(path.join(draft, 'assets/click.wav'), 'second');
    const next = store.save(store.readDraft(profile.id), true);
    assert.notEqual(next.appearance.profiles[0].shell!.assets!['assets/click.wav'], url);
    const rollback = store.change({
      action: 'rollback',
      id: profile.id,
      revision: next.appearance.revision,
    });
    assert.equal(rollback.appearance.profiles[0].shell!.assets!['assets/click.wav'], url);
    const other = new LocalAppearanceStore(path.join(root, 'two')),
      imported = other.importBundle(store.exportBundle(profile.id));
    const importedURL = imported.shell!.assets!['assets/click.wav'];
    assert.notEqual(importedURL, url);
    assert.equal(other.readAsset(importedURL).data.toString(), 'RIFF-test');
    assert.throws(() => other.readAsset(url), /unavailable/);
    const cacheFile = path.join(store.directory, '.assets', new URL(url).pathname.slice(1));
    fs.writeFileSync(cacheFile, 'tampered');
    assert.throws(() => store.readAsset(url), /invalid/);
    assert.ok(!isAppearanceAssetPath('assets/../escape.wav'));
    assert.ok(!isAppearanceAssetPath('assets/code.js'));
    assert.throws(
      () =>
        parseAppearanceProject({
          entry: 'App.tsx',
          files: profile.shell.files,
          assets: { 'assets/no.wav': 'file:///C:/one' },
        }),
      /appearance/,
    );
    const large = path.join(draft, 'assets/large.wav'),
      fd = fs.openSync(large, 'w');
    fs.ftruncateSync(fd, APPEARANCE_ASSET_LIMITS.fileBytes + 1);
    fs.closeSync(fd);
    assert.throws(() => store.readDraft(profile.id), /appearance_asset_limit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('real bundled library declarations and effects examples type-check outside repository node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-types-'));
  try {
    const store = new LocalAppearanceStore(root);
    const draft = path.join(root, 'templates/component');
    for (const group of ['effects', 'dnd']) {
      const examples = path.join(root, 'examples', group);
      for (const name of fs.readdirSync(examples))
        fs.copyFileSync(path.join(examples, name), path.join(draft, name));
    }
    const file = ts.readConfigFile(path.join(draft, 'tsconfig.json'), ts.sys.readFile);
    const config = ts.parseJsonConfigFileContent(file.config, ts.sys, draft);
    const program = ts.createProgram(config.fileNames, config.options);
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .filter((item) => item.category === ts.DiagnosticCategory.Error)
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      [],
    );
    assert.ok(
      fs.existsSync(path.join(root, 'types/node_modules/@types/three/build/three.module.d.ts')),
    );
    for (const name of ['core', 'sortable', 'modifiers', 'utilities'])
      assert.ok(
        fs.existsSync(path.join(root, 'types/node_modules/@dnd-kit', name, 'dist/index.d.ts')),
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
