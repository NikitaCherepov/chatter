type ParserSpec = { parser: string; plugins: string[] };
const scriptPlugins = ['babel', 'estree'];
const markupPlugins = ['html', 'babel', 'estree', 'typescript', 'postcss'];
const parsers: Record<string, ParserSpec> = {
  javascript: { parser: 'babel', plugins: scriptPlugins },
  jsx: { parser: 'babel', plugins: scriptPlugins },
  typescript: { parser: 'typescript', plugins: ['typescript', 'estree'] },
  tsx: { parser: 'typescript', plugins: ['typescript', 'estree'] },
  json: { parser: 'json', plugins: scriptPlugins },
  json5: { parser: 'json5', plugins: scriptPlugins },
  css: { parser: 'css', plugins: ['postcss'] },
  scss: { parser: 'scss', plugins: ['postcss'] },
  less: { parser: 'less', plugins: ['postcss'] },
  html: { parser: 'html', plugins: markupPlugins },
  vue: { parser: 'vue', plugins: markupPlugins },
  yaml: { parser: 'yaml', plugins: ['yaml'] },
  markdown: { parser: 'markdown', plugins: ['markdown'] },
};
const aliases: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript', ecmascript: 'javascript',
  ts: 'typescript', yml: 'yaml', md: 'markdown', htm: 'html',
};
export const normalizeCodeLanguage = (language: string) => {
  const lang = language.toLowerCase();
  return Object.prototype.hasOwnProperty.call(aliases, lang) ? aliases[lang] : lang;
};
export const canFormatCode = (language: string) => Object.prototype.hasOwnProperty.call(parsers, normalizeCodeLanguage(language));
const MAX_FORMAT_LENGTH = 100_000;
const MAX_CACHE_LENGTH = 1_000_000;
const cache = new Map<string, string | null>();
let cacheLength = 0;

async function loadPlugin(name: string) {
  switch (name) {
    case 'babel': return import('prettier/plugins/babel');
    case 'estree': return import('prettier/plugins/estree');
    case 'typescript': return import('prettier/plugins/typescript');
    case 'postcss': return import('prettier/plugins/postcss');
    case 'html': return import('prettier/plugins/html');
    case 'yaml': return import('prettier/plugins/yaml');
    case 'markdown': return import('prettier/plugins/markdown');
    default: throw new Error('Unknown formatter plugin');
  }
}

/** Formatting affects presentation and copying only; the saved message and previews keep the source. */
export async function formatCode(code: string, language: string): Promise<string | null> {
  const lang = normalizeCodeLanguage(language);
  if (!canFormatCode(lang) || code.length > MAX_FORMAT_LENGTH) return null;
  const key = lang + '\0' + code;
  if (cache.has(key)) return cache.get(key)!;
  let result: string | null = null;
  try {
    const spec = parsers[lang];
    const [prettier, plugins] = await Promise.all([
      import('prettier/standalone'), Promise.all(spec.plugins.map(loadPlugin)),
    ]);
    result = await prettier.format(code, {
      parser: spec.parser, plugins, semi: true, singleQuote: true, tabWidth: 2,
      printWidth: 100, trailingComma: 'es5', embeddedLanguageFormatting: lang === 'html' || lang === 'vue' ? 'auto' : 'off',
    });
  } catch { /* Partial snippets and invalid code must remain visible verbatim. */ }
  const size = key.length + (result?.length || 0);
  while (cache.size && (cache.size >= 100 || cacheLength + size > MAX_CACHE_LENGTH)) {
    const oldest = cache.keys().next().value!;
    cacheLength -= oldest.length + (cache.get(oldest)?.length || 0);
    cache.delete(oldest);
  }
  cache.set(key, result); cacheLength += size;
  return result;
}

export async function highlightCode(code: string, language: string): Promise<string | null> {
  try {
    const { default: hljs } = await import('highlight.js/lib/common');
    const lang = normalizeCodeLanguage(language);
    // Never guess a different language for an explicitly labelled block.
    return hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : null;
  } catch { return null; }
}

export type FormattedCode = { source: string; language: string; text: string; html: string | null };
export function currentFormattedCode(result: FormattedCode | null, source: string, language: string, closed: boolean) {
  return closed && result?.source === source && result.language === language ? result : null;
}
