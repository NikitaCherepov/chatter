const fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
const { build } = require('vite'),
  { zipSync } = require('fflate');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'dist/theme-libraries');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  for (const [entry, name, global] of [
    ['three', 'three', 'ChatterThree'],
    ['motion', 'motion', 'ChatterMotion'],
    ['gsap', 'gsap', 'ChatterGsap'],
    ['dnd', 'dnd', 'ChatterDnd'],
  ]) {
    await build({
      configFile: false,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: out,
        emptyOutDir: false,
        minify: true,
        lib: {
          entry: path.join(root, 'src/interactive/libraries', entry + '.ts'),
          name: global,
          formats: ['iife'],
          fileName: () => name + '.js',
        },
        rollupOptions: {
          external: ['react', 'react-dom', 'react-dom/client'],
          output: {
            globals: {
              react: 'ChatterReact',
              'react-dom': 'ChatterReactDOM',
              'react-dom/client': 'ChatterReactDOMClient',
            },
            inlineDynamicImports: true,
          },
        },
      },
    });
  }
  // Portable, actual installed declarations. This is generated build output, not theme runtime code.
  const entry = path.join(root, '.theme-library-types.ts'),
    source =
      "import 'three';import '@react-three/fiber';import '@react-three/drei';import 'framer-motion';import 'gsap';import '@dnd-kit/core';import '@dnd-kit/sortable';import '@dnd-kit/modifiers';import '@dnd-kit/utilities';";
  const options = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
    jsx: ts.JsxEmit.ReactJSX,
  };
  const host = ts.createCompilerHost(options),
    read = host.readFile.bind(host),
    exists = host.fileExists.bind(host);
  host.readFile = (file) => (path.resolve(file) === entry ? source : read(file));
  host.fileExists = (file) => path.resolve(file) === entry || exists(file);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) =>
    path.resolve(file) === entry
      ? ts.createSourceFile(file, source, languageVersion, true)
      : getSourceFile(file, languageVersion, ...rest);
  const program = ts.createProgram([entry], options, host),
    files = {},
    packages = new Set();
  const prefix = path.join(root, 'node_modules') + path.sep;
  for (const file of program.getSourceFiles()) {
    if (
      !file.isDeclarationFile ||
      !path.resolve(file.fileName).startsWith(prefix) ||
      /[\\/]typescript[\\/]lib[\\/]lib\./.test(file.fileName)
    )
      continue;
    const relative = path
      .relative(path.join(root, 'node_modules'), file.fileName)
      .replaceAll('\\', '/');
    files[relative] = new Uint8Array(Buffer.from(file.text));
    const parts = relative.split('/'),
      name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    packages.add(name);
  }
  for (const name of packages) {
    const file = path.join(root, 'node_modules', name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8')),
      { types, typings, typesVersions, exports: exportsMap, version } = json;
    files[name + '/package.json'] = new Uint8Array(
      Buffer.from(
        JSON.stringify({ name, version, types, typings, typesVersions, exports: exportsMap }),
      ),
    );
  }
  if (!Object.keys(files).length) throw new Error('No theme library declarations resolved');
  fs.writeFileSync(path.join(out, 'types.zip'), zipSync(files, { level: 6 }));
  const versions = {};
  for (const name of [
    'three',
    '@react-three/fiber',
    '@react-three/drei',
    'framer-motion',
    'gsap',
    '@dnd-kit/core',
    '@dnd-kit/sortable',
    '@dnd-kit/modifiers',
    '@dnd-kit/utilities',
  ]) {
    versions[name] = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    ).version;
  }
  fs.writeFileSync(path.join(out, 'versions.json'), JSON.stringify(versions, null, 2));
  console.log(
    'Theme libraries: ' +
      Object.keys(files).length +
      ' declaration/service files; versions ' +
      JSON.stringify(versions),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
