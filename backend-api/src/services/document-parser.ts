import path from 'node:path';
import { MAX_EXTRACTED_TEXT_CHARS } from './attachment-storage';

/**
 * Extensions we accept as plain text (extracted as-is, UTF-8).
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'ini', 'toml', 'env', 'conf', 'cfg',
  'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'rb', 'php', 'pl', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1',
  'sql', 'graphql', 'gql',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'rtf',
]);

const DOCX_EXTENSIONS = new Set(['docx']);
const PDF_EXTENSIONS = new Set(['pdf']);

/** Combined set for validation/UI */
export const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...DOCX_EXTENSIONS,
  ...PDF_EXTENSIONS,
]);

/**
 * Returns lowercase extension (without dot) of a filename, or '' if none.
 */
const getExt = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
};

/**
 * Truncate text to MAX_EXTRACTED_TEXT_CHARS to protect the server.
 */
const clampText = (text: string): string => {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
  // Keep head + tail so the user/AI sees beginning and end of a large file.
  const head = text.slice(0, Math.floor(MAX_EXTRACTED_TEXT_CHARS * 0.85));
  const tail = text.slice(text.length - Math.floor(MAX_EXTRACTED_TEXT_CHARS * 0.15));
  return `${head}\n\n…[обрезано: превышен лимит ${MAX_EXTRACTED_TEXT_CHARS} символов]…\n\n${tail}`;
};

/**
 * Extract plain text from a document buffer.
 *
 * Supported:
 *  - txt/md/json/csv/log/xml/yaml/code/etc → UTF-8 as-is
 *  - docx → mammoth.extractRawText
 *  - pdf  → pdf-parse
 *
 * Throws on unknown extension or parse failure.
 */
export const parseDocument = async (
  buffer: Buffer,
  originalName: string
): Promise<string> => {
  const ext = getExt(originalName);

  if (!ext) {
    throw new Error(`Не удалось определить расширение файла: ${originalName}`);
  }

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Неподдерживаемый формат документа: .${ext}`);
  }

  let raw: string;

  if (TEXT_EXTENSIONS.has(ext)) {
    raw = buffer.toString('utf-8');
  } else if (DOCX_EXTENSIONS.has(ext)) {
    // mammoth — извлекает чистый текст из .docx
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    raw = result.value || '';
  } else if (PDF_EXTENSIONS.has(ext)) {
    // pdf-parse — извлекает текст из .pdf
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = (pdfParseModule as any).default ?? pdfParseModule;
    const result = await pdfParse(buffer);
    raw = result.text || '';
  } else {
    // defensive
    throw new Error(`Неподдерживаемый формат документа: .${ext}`);
  }

  return clampText(raw);
};

/**
 * MIME type fallback (used for metadata when real MIME is unknown).
 */
export const guessMimeType = (filename: string): string => {
  const ext = getExt(filename);
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    log: 'text/plain',
    xml: 'application/xml',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    ini: 'text/plain',
    toml: 'text/plain',
    env: 'text/plain',
    conf: 'text/plain',
    cfg: 'text/plain',
    py: 'text/x-python',
    js: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    go: 'text/x-go',
    rs: 'text/rust',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    cc: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    rb: 'text/x-ruby',
    php: 'text/x-php',
    pl: 'text/x-perl',
    lua: 'text/x-lua',
    sh: 'application/x-sh',
    bash: 'application/x-sh',
    zsh: 'application/x-sh',
    fish: 'application/x-sh',
    bat: 'application/x-bat',
    ps1: 'application/x-powershell',
    sql: 'application/sql',
    graphql: 'application/graphql',
    gql: 'application/graphql',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    scss: 'text/x-scss',
    sass: 'text/x-sass',
    less: 'text/x-less',
    rtf: 'application/rtf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
};
