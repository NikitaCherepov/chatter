import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('../node_modules/typescript');
const code = ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/tools.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const opens: any[] = [], docks: string[] = [];
let dockResolve: (() => void) | undefined;
const context: any = { exports: {}, console, window: { addEventListener: () => {}, electronAPI: {
  openToolWindow: async (payload: any) => { opens.push(payload); return { opened: true }; },
  dockToolWindow: (id: string) => { docks.push(id); return new Promise<void>(resolve => { dockResolve = () => { context.exports.setToolLayout(id, { mode: 'sidebar' }); resolve(); }; }); },
} } };
vm.createContext(context); vm.runInContext(code, context);
const tools = context.exports;
tools.handleDesktopAction({ action: 'open_widget', target: 'browser', value: { layout: 'fullscreen' } });
assert.equal(tools.getToolLayout('browser').mode, 'fullscreen'); assert.equal(tools.getToolsPanelState().isOpen, false);
tools.handleDesktopAction({ action: 'open_widget', target: 'browser' });
assert.equal(tools.getToolLayout('browser').mode, 'fullscreen', 'browser actions preserve the chosen layout');
tools.handleDesktopAction({ action: 'open_widget', target: 'browser', value: { layout: 'external', maximize: true } });
assert.equal(opens[0].maximize, true); assert.equal(tools.getToolLayout('browser').mode, 'external');
tools.handleDesktopAction({ action: 'open_widget', target: 'browser', value: { layout: 'fullscreen' } });
assert.equal(docks[0], 'browser'); assert.equal(tools.getToolLayout('browser').mode, 'external', 'wait for native window closure');
dockResolve!(); for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(tools.getToolLayout('browser').mode, 'fullscreen', 'closed event cannot undo requested layout');
tools.handleDesktopAction({ action: 'open_widget', target: 'tasks', value: { layout: 'floating' } });
assert.equal(tools.getToolLayout('tasks').mode, 'floating');
tools.handleDesktopAction({ action: 'open_widget', target: 'notebook', value: { layout: 'sidebar' } });
assert.equal(tools.getToolsPanelState().isOpen, true);
tools.handleDesktopAction({ action: 'close_widget', target: 'tasks' });
assert.ok(!tools.getToolsPanelState().openTools.includes('tasks'));
console.log('PASS: actual desktop action handler, fullscreen, floating, separate/maximized window, docking order and preserved browser layout');
