import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as ts from 'typescript';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as ChatterUI from './chatter-ui';
import {loadThemeLibraries,themeLibrary} from './theme-libraries';
import {installThemeEffectsRuntime,syncThemeEffectsRuntime} from './effects-sdk';
import {
  compileAppearanceProject,
  resolveAppearanceImport,
} from '../renderer/lib/appearance-project';

// This bundle runs only in the isolated WebContents, never in the chat renderer.
const payload = JSON.parse(document.getElementById('preview-source')!.textContent!);
const root = createRoot(document.getElementById('root')!);
installThemeEffectsRuntime();
class PreviewErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    (window as any).chatter?.reportError();
  }
  render() {
    return this.state.failed ? <p role="alert">{payload.errorLabel}</p> : this.props.children;
  }
}
async function start() {
  const bundledRequire = (name: string) => {
    if (name === 'react') return React;
    if (name === 'react-markdown') return { default: ReactMarkdown, __esModule: true };
    if (name === 'remark-gfm') return { default: remarkGfm, __esModule: true };
    if (name === '@chatter/ui') return ChatterUI;
    const optional=themeLibrary(name);if(optional)return optional;
    throw new Error('Only bundled react, react-markdown, remark-gfm and @chatter/ui modules are available');
  };
  let Component: any;
  if (payload.project) {
    const { project, compiled, diagnostics } = compileAppearanceProject(payload.project, ts);
    if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
    await loadThemeLibraries(Object.values(compiled));
    syncThemeEffectsRuntime();
    const cache = new Map<string, { exports: any }>();
    const load = (file: string): any => {
      if (cache.has(file)) return cache.get(file)!.exports;
      const module = { exports: {} as any };
      cache.set(file, module);
      if (file.endsWith('.css')) {
        const style = document.createElement('style');
        style.textContent = project.files[file];
        document.head.append(style);
      } else if (file.endsWith('.json')) module.exports = JSON.parse(project.files[file]);
      else {
        const require = (request: string) => {
          const resolved = resolveAppearanceImport(project, file, request);
          return Object.prototype.hasOwnProperty.call(project.files, resolved)
            ? load(resolved)
            : bundledRequire(resolved);
        };
        new Function(
          'React',
          'require',
          'exports',
          'module',
          compiled[file] + '\n//# sourceURL=appearance/' + file,
        )(React, require, module.exports, module);
      }
      return module.exports;
    };
    Component = load(project.entry).default;
  } else {
    const compiled = ts.transpileModule(payload.source, {
      fileName: 'Preview.tsx',
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
        isolatedModules: true,
      },
    });
    if (compiled.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error))
      throw new Error('Invalid JSX/TSX');
    await loadThemeLibraries([compiled.outputText]);
    syncThemeEffectsRuntime();
    const exports: Record<string, unknown> = {};
    const module = { exports };
    Component = new Function(
      'React',
      'require',
      'exports',
      'module',
      `${compiled.outputText}\nreturn module.exports.default ?? (typeof App === 'function' ? App : null);`,
    )(React, bundledRequire, exports, module);
  }
  if (!Component || (typeof Component !== 'function' && typeof Component !== 'object'))
    throw new Error('Export a default React component');
  root.render(
    <PreviewErrorBoundary>
      <Component />
    </PreviewErrorBoundary>,
  );
}
void start().catch(() => {
  (window as any).chatter?.reportError();
  root.render(<p role="alert">{payload.errorLabel}</p>);
});
