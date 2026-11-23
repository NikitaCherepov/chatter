import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LocalAppearanceStore, copyAppearanceWorkspace } = require('../src/main/local-appearance.ts');
const { newAppearance, parseAppearanceProfile, APPEARANCE_README_MAX_BYTES } = require('../src/main/appearance-schema.ts');
const { APPEARANCE_LABEL_KEYS } = require('../src/main/appearance-shell-types.ts');
const { unzipSync } = require('fflate');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-theme-readme-'));
try {
  const store = new LocalAppearanceStore(path.join(temporary, 'themes'));
  const note = '# Тема\r\n\r\nИдея, файлы и ограничения.\r\n';
  store.writeDraft(newAppearance('ordinary'));
  const draft = path.join(store.directory, '.drafts/ordinary');
  assert.equal(fs.existsSync(path.join(draft, 'README.md')), false, 'documentation is optional');
  fs.writeFileSync(path.join(draft, 'README.md'), note);
  const captured = store.readDraft('ordinary');
  assert.equal(captured.readme, note, 'UTF-8 and line endings are retained exactly');
  const saved = store.save(captured, false);
  const publication = saved.workspace.profiles.find((item: any) => item.id === 'ordinary').directory;
  assert.equal(fs.readFileSync(path.join(publication, 'README.md'), 'utf8'), note);
  assert.equal(JSON.parse(fs.readFileSync(path.join(publication, 'theme.json'), 'utf8')).readme, undefined);
  assert.equal(saved.appearance.activeId, null);
  const reopened = new LocalAppearanceStore(store.directory);
  assert.equal(reopened.load().appearance.profiles[0].readme, note);

  fs.writeFileSync(path.join(draft, 'README.md'), '# New draft');
  assert.equal(store.load().appearance.profiles[0].readme, note, 'draft edits do not mutate publication');
  const next = store.save(store.readDraft('ordinary'), false);
  const rolledBack = store.change({ action: 'rollback', id: 'ordinary', revision: next.appearance.revision });
  assert.equal(rolledBack.appearance.profiles[0].readme, note, 'rollback restores the matching README');
  assert.equal(store.readDraft('ordinary').readme, note, 'an unchanged draft follows the restored publication');
  store.writeDraft({ ...store.readDraft('ordinary'), name: 'Edited styling' });
  assert.equal(fs.readFileSync(path.join(draft, 'README.md'), 'utf8'), note, 'native editor round-trip retains docs');

  const bundle = store.exportBundle('ordinary');
  assert.equal(Buffer.from(unzipSync(bundle)['README.md']).toString('utf8'), note);
  const receiver = new LocalAppearanceStore(path.join(temporary, 'receiver'));
  const imported = receiver.importBundle(bundle);
  assert.equal(imported.readme, note);
  assert.equal(receiver.readDraft(imported.id).readme, note);
  assert.equal(receiver.load().appearance.profiles.length, 0, 'import only creates a draft');
  const transported = JSON.parse(JSON.stringify(store.load().appearance.profiles[0]));
  assert.equal(parseAppearanceProfile(transported).readme, note, 'profile transport retains documentation');

  const proposal = store.readDraft('ordinary');
  fs.writeFileSync(path.join(draft, 'README.md'), '# Newer work while proposal is pending');
  store.save(proposal, false);
  assert.equal(store.load().appearance.profiles[0].readme, note, 'a proposal publishes its captured README');
  assert.equal(store.readDraft('ordinary').readme, '# Newer work while proposal is pending', 'publishing does not clobber newer external docs');
  store.save(store.readDraft('ordinary'), false);
  fs.unlinkSync(path.join(draft, 'README.md'));
  const without = store.save(store.readDraft('ordinary'), false);
  assert.equal(without.appearance.profiles[0].readme, undefined);
  const withoutDirectory = without.workspace.profiles.find((item: any) => item.id === 'ordinary').directory;
  assert.equal(fs.existsSync(path.join(withoutDirectory, 'README.md')), false, 'deleting and publishing removes docs');
  fs.writeFileSync(path.join(draft, 'README.md'), '');
  assert.equal(store.save(store.readDraft('ordinary'), false).appearance.profiles[0].readme, '', 'an empty README is preserved');

  const readme = 'я'.repeat(APPEARANCE_README_MAX_BYTES / 2);
  const prefix = 'export default function App(){return null}/*', suffix = '*/';
  const source = prefix + 'x'.repeat(500_000 - prefix.length - suffix.length) + suffix;
  const project = { ...newAppearance('project'), readme, shell: { version: 1, language: 'tsx', entry: 'App.tsx', files: { 'App.tsx': source } } };
  store.writeDraft(project);
  const readProject = store.readDraft('project');
  assert.equal(readProject.readme, readme);
  assert.deepEqual(Object.keys(readProject.shell.files), ['App.tsx'], 'README is excluded from all runtime files');
  store.save(readProject, false);
  assert.equal(receiver.importBundle(store.exportBundle('project')).readme, readme, 'independent README budget survives ZIP');
  assert.throws(() => parseAppearanceProfile({ ...project, readme: readme + 'я' }), /appearance_invalid/);
  assert.throws(() => parseAppearanceProfile({ ...project, readme: 42 }), /appearance_invalid/);
  const projectReadme = path.join(store.directory, '.drafts/project/README.md');
  fs.writeFileSync(projectReadme, readme + 'я');
  assert.throws(() => store.readDraft('project'), /appearance_file_too_large/);
  fs.writeFileSync(projectReadme, readme);

  const destination = path.join(temporary, 'moved'); fs.mkdirSync(destination);
  const moved = copyAppearanceWorkspace(store, destination);
  assert.equal(moved.readDraft('project').readme, readme);
  assert.equal(moved.load().appearance.profiles.find((item: any) => item.id === 'project').readme, readme);
  assert.equal(JSON.stringify(moved.load().workspace).includes('Newer work while proposal'), false, 'workspace metadata never dumps README contents');

  const reference = JSON.parse(fs.readFileSync(path.join(store.directory, 'docs/appearance.json'), 'utf8'));
  assert.equal(reference.template, undefined); assert.equal(reference.paletteExample, undefined);
  assert.equal(reference.materials.template, undefined, 'reference does not embed concrete manifests/default materials');
  assert.ok(fs.existsSync(path.join(store.directory, 'template.json')));
  assert.ok(fs.existsSync(path.join(store.directory, 'templates/component/README.md')));
  assert.ok(fs.existsSync(path.join(store.directory, 'templates/html/README.md')));
  const declarations = fs.readFileSync(path.join(store.directory, 'chatter.d.ts'), 'utf8');
  const runtime = fs.readFileSync(path.join(store.directory, 'docs/runtime.md'), 'utf8');
  for (const key of APPEARANCE_LABEL_KEYS) {
    assert.ok(declarations.includes(JSON.stringify(key)), key + ' is an explicit label key');
    assert.ok(runtime.includes(key), key + ' is documented');
  }
  const media = fs.readFileSync(path.join(store.directory, 'docs/media.md'), 'utf8');
  assert.ok(media.includes('button.chatter-image-error') && media.includes('no reliable original extraction'));
  console.log('PASS: ordinary/project README persistence, exact UTF-8, atomic captured proposals, rollback, deletion/empty docs, ZIP and workspace copy, separate code/byte budgets, focused references and localized label declarations');
} finally {
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), 'chatter-theme-readme-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}
