import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as ts from 'typescript';

// This bundle runs only in the isolated WebContents, never in the chat renderer.
const payload = JSON.parse(document.getElementById('preview-source')!.textContent!);
const root = createRoot(document.getElementById('root')!);
class PreviewErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">{payload.errorLabel}</p> : this.props.children; }
}
try {
  const compiled = ts.transpileModule(payload.source, {
    fileName: 'Preview.tsx', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, esModuleInterop: true, isolatedModules: true },
  });
  if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('Invalid JSX/TSX');
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const localRequire = (name: string) => {
    if (name === 'react') return React;
    throw new Error('Only the bundled React module is available');
  };
  const Component = new Function('React', 'require', 'exports', 'module',
    `${compiled.outputText}\nreturn module.exports.default ?? (typeof App === 'function' ? App : null);`)(React, localRequire, exports, module);
  if (typeof Component !== 'function') throw new Error('Export a default React component');
  root.render(<PreviewErrorBoundary><Component /></PreviewErrorBoundary>);
} catch {
  root.render(<p role="alert">{payload.errorLabel}</p>);
}
