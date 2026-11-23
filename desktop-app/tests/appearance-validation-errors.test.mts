import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { parseAppearanceProject, APPEARANCE_PROJECT_LIMITS } = require('../src/main/appearance-project.ts');
const { newAppearance, parseAppearanceProfile } = require('../src/main/appearance-schema.ts');
const { validateAppearanceCode } = require('../src/renderer/lib/appearance-validation.ts');
const project = { entry: 'App.tsx', files: { 'App.tsx': 'export default function App(){return <main>Theme</main>}', 'styles.css': '/*' + 'x'.repeat(114585) + '*/' } };
assert.ok(parseAppearanceProject(project));
const tooLarge = { ...project, files: { ...project.files, 'styles.css': 'x'.repeat(APPEARANCE_PROJECT_LIMITS.sourceLength + 1) } };
assert.throws(() => parseAppearanceProject(tooLarge), (error: any) => {
  assert.equal(error.message, 'appearance_project_limit');
  assert.ok(error.diagnostics[0].message.includes('500000'));
  assert.ok(error.diagnostics[0].message.includes('2 files'));
  return true;
});
assert.throws(() => parseAppearanceProject({ entry: 'Missing.tsx', files: project.files }), (error: any) => error.diagnostics[0].message.includes('Missing.tsx'));

// Run the actual main-process read-draft boundary and renderer workspace tool in one VM.
const main = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const readCase = main.slice(main.indexOf("    case 'read-draft':"), main.indexOf("    case 'write-draft':"));
const service = fs.readFileSync(new URL('../src/renderer/lib/appearance-service.ts', import.meta.url), 'utf8');
const local = service.slice(service.indexOf('export async function localAppearance('), service.indexOf('export async function fetchAppearance('));
const workspace = service.slice(service.indexOf('export async function executeAppearanceWorkspace('), service.indexOf('export function useAppearance('));
let draft: any = { ...newAppearance('test'), shell: { version: 1, language: 'tsx', scope: 'workspace', ...tooLarge } };
const context: any = { exports: {}, parseAppearanceProfile, validateAppearanceCode, Object, Error,
  store: { readDraft: () => parseAppearanceProfile(draft) },
  window: { electronAPI: { localAppearance: (payload: any) => context.readFromMain(payload) } } };
vm.createContext(context);
vm.runInContext(ts.transpileModule('function readFromMain(payload){switch("read-draft"){' + readCase + '}}\n' + local + workspace,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
const rejected = await context.executeAppearanceWorkspace({ action: 'preview', id: 'test', checkOnly: true });
assert.equal(rejected.error, 'appearance_project_limit');
assert.ok(rejected.diagnostics[0].message.includes('500000'), 'main IPC must retain structured diagnostics instead of serializing an exception');
draft = { ...draft, shell: { ...draft.shell, files: project.files } };
assert.equal((await context.executeAppearanceWorkspace({ action: 'preview', id: 'test', checkOnly: true })).status, 'valid');
draft = { ...draft, shell: { ...draft.shell, files: { 'App.tsx': 'export default function App(){return <main>}' } } };
const syntax = await context.executeAppearanceWorkspace({ action: 'preview', id: 'test', checkOnly: true });
assert.equal(syntax.error, 'appearance_build_failed');
assert.equal(syntax.diagnostics[0].file, 'App.tsx');
console.log('PASS: multi-file budget, exact limit/missing-entry diagnostics, actual main-to-renderer error transport and checkOnly validation without proposal');
