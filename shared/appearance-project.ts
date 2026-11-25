// Canonical virtual appearance project. Synced by scripts/sync-appearance.mjs.
import type * as TypeScript from 'typescript';

export type AppearanceProject = { entry: string; files: Record<string, string>; assets?: Record<string,string> };
export const APPEARANCE_ASSET_LIMITS = { files:128, fileBytes:32*1024*1024, totalBytes:64*1024*1024, archiveBytes:96*1024*1024 } as const;
export const APPEARANCE_ASSET_MIME: Record<string,string> = {
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',
  mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',flac:'audio/flac',
  glb:'model/gltf-binary',hdr:'application/octet-stream',ttf:'font/ttf',woff:'font/woff',woff2:'font/woff2',
};
export function isAppearanceAssetPath(value:unknown):boolean {
  return typeof value==='string' && value.length<=180 && value.startsWith('assets/')
    && value.split('/').every(part=>/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))
    && Object.prototype.hasOwnProperty.call(APPEARANCE_ASSET_MIME,value.split('.').at(-1)!);
}
export function isAppearanceAssetURL(value:unknown):value is string {
  return typeof value==='string' && /^chatter-theme:\/\/[a-f0-9]{24}\/[a-f0-9]{64}\.[a-z0-9]+$/.test(value)
    && Object.prototype.hasOwnProperty.call(APPEARANCE_ASSET_MIME,value.split('.').at(-1)!);
}
export type AppearanceCodeDiagnostic = {
  file: string;
  line: number;
  column: number;
  message: string;
};
export const APPEARANCE_PROJECT_LIMITS = { files: 256, sourceLength: 500_000 } as const;
export const APPEARANCE_PROJECT_MODULES = ['react', 'react-markdown', 'remark-gfm', '@chatter/ui',
  'three','@react-three/fiber','@react-three/drei','framer-motion','gsap',
  '@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/modifiers','@dnd-kit/utilities'] as const;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

export function isAppearanceFilePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 180 &&
    value.split('/').every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part)) &&
    /\.(tsx?|jsx?|css|json|html)$/.test(value)
  );
}

export function parseAppearanceProject(value: unknown): AppearanceProject {
  const project = value as Partial<AppearanceProject> | null;
  const invalid = (message = 'Invalid theme project entry or source files.', code = 'appearance_invalid') => {
    throw Object.assign(new Error(code), { diagnostics: [{ file: typeof project?.entry === 'string' ? project.entry : 'theme.json', line: 1, column: 1, message }] });
  };
  if (
    !project ||
    !isAppearanceFilePath(project.entry) ||
    !/\.(?:[jt]sx?|html)$/.test(project.entry) ||
    /\.d\.ts$/.test(project.entry) ||
    !project.files ||
    typeof project.files !== 'object' ||
    Array.isArray(project.files)
  )
    return invalid();
  const files = Object.entries(project.files);
  if (!files.length) return invalid('The theme project has no runtime source files.');
  if (files.length > APPEARANCE_PROJECT_LIMITS.files)
    return invalid(`Theme project has ${files.length} runtime files; the limit is ${APPEARANCE_PROJECT_LIMITS.files}.`, 'appearance_project_limit');
  if (!own(project.files, project.entry)) return invalid(`Entry file ${project.entry} is missing from the theme project.`);
  let length = 0;
  for (const [file, source] of files) {
    if (!isAppearanceFilePath(file) || typeof source !== 'string') return invalid(`Invalid theme source file: ${file}.`);
    length += source.length;
  }
  if (length > APPEARANCE_PROJECT_LIMITS.sourceLength)
    return invalid(`Theme project contains ${length} source characters across ${files.length} files; the total limit is ${APPEARANCE_PROJECT_LIMITS.sourceLength}. This counts every runtime file together; splitting files does not reduce the total.`, 'appearance_project_limit');
  if (!project.files[project.entry].trim()) return invalid(`Entry file ${project.entry} is empty.`);
  if(project.assets!==undefined && (!project.assets || typeof project.assets!=='object' || Array.isArray(project.assets)
    || Object.keys(project.assets).length>APPEARANCE_ASSET_LIMITS.files
    || Object.entries(project.assets).some(([name,url])=>!isAppearanceAssetPath(name)||!isAppearanceAssetURL(url))))
    return invalid('Invalid theme asset registry.');
  return { entry: project.entry, files: Object.fromEntries(files), ...(project.assets?{assets:{...project.assets}}:{}) };
}

/** Resolve only files supplied in the profile. Never consult disk or the network. */
export function resolveAppearanceImport(
  project: AppearanceProject,
  from: string,
  request: string,
): string {
  const rooted = request.startsWith('@/');
  if (!rooted && !request.startsWith('./') && !request.startsWith('../')) {
    if ((APPEARANCE_PROJECT_MODULES as readonly string[]).includes(request)) return request;
    throw new Error(`Unsupported module: ${request}`);
  }
  const segments = rooted ? [] : from.split('/').slice(0, -1);
  for (const part of (rooted ? request.slice(2) : request).split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!segments.length) throw new Error(`Import escapes the project: ${request}`);
      segments.pop();
    } else segments.push(part);
  }
  const path = segments.join('/');
  const found = [
    path,
    ...(/\.jsx?$/.test(path)
      ? [path.replace(/\.js$/, '.ts'), path.replace(/\.jsx?$/, '.tsx')]
      : []),
    ...[
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '.css',
      '.json',
      '/index.tsx',
      '/index.ts',
      '/index.jsx',
      '/index.js',
    ].map((ext) => path + ext),
  ].find((candidate) => own(project.files, candidate));
  if (!found) throw new Error(`File not found: ${request}`);
  if (found.endsWith('.d.ts')) throw new Error(`Use import type for declarations: ${request}`);
  return found;
}

/** Syntax and imports only. Model code is never executed during validation. */
export function compileAppearanceProject(value: AppearanceProject, ts: typeof TypeScript) {
  const project = parseAppearanceProject(value);
  const diagnostics: AppearanceCodeDiagnostic[] = [];
  const compiled: Record<string, string> = {};
  for (const [file, source] of Object.entries(project.files)) {
    if (file.endsWith('.d.ts') || file.endsWith('.html')) continue;
    const report = (message: string, offset = 0) => {
      const before = source.slice(0, offset).split('\n');
      diagnostics.push({
        file,
        line: before.length,
        column: before[before.length - 1].length + 1,
        message,
      });
    };
    if (file.endsWith('.css')) {
      if (/@import\b/i.test(source)) report('Import CSS from a script instead of using @import.');
      continue;
    }
    if (file.endsWith('.json')) {
      try {
        JSON.parse(source);
      } catch {
        report('Invalid JSON');
      }
      continue;
    }
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.ES2020,
      true,
      file.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : file.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : file.endsWith('.js')
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
    const checkImport = (node: TypeScript.Node, request: string) => {
      try {
        resolveAppearanceImport(project, file, request);
      } catch (error) {
        report((error as Error).message, node.getStart(tree));
      }
    };
    const visit = (node: TypeScript.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly
          : node.isTypeOnly;
        if (!typeOnly) checkImport(node, node.moduleSpecifier.text);
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        checkImport(node, node.moduleReference.expression.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument))
          report('Imports must use a literal module path.', node.getStart(tree));
        else checkImport(node, argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    const result = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
        isolatedModules: true,
      },
    });
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.category === ts.DiagnosticCategory.Error)
        report(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          diagnostic.start ?? 0,
        );
    }
    compiled[file] = result.outputText;
    if (
      file === project.entry &&
      !tree.statements.some(
        (statement) =>
          (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
          (ts.canHaveModifiers(statement) &&
            ts
              .getModifiers(statement)
              ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) ||
          (ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.some((element) => element.name.text === 'default')),
      )
    )
      report('The entry file must export a default React component.');
  }
  return { project, compiled, diagnostics: diagnostics.slice(0, 20) };
}
