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
const SPREADSHEET_EXTENSIONS = new Set(['xlsx']);

/** Combined set for validation/UI */
export const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...DOCX_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...SPREADSHEET_EXTENSIONS,
]);

const SPREADSHEET_OUTPUT_RESERVE = 256;
const MAX_SPREADSHEET_COLUMNS = 100;
const MAX_SPREADSHEET_CELL_CHARS = 2_000;

const excelColumnName = (index: number): string => {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
};

const markdownCell = (value: unknown): string => {
  const text = value instanceof Date
    ? value.toISOString()
    : value == null
      ? ''
      : String(value);
  const trimmed = text.length > MAX_SPREADSHEET_CELL_CHARS
    ? `${text.slice(0, MAX_SPREADSHEET_CELL_CHARS)}…`
    : text;
  return trimmed
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()<>|])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
};

const spreadsheetToMarkdown = (
  sheets: Array<{ sheet: string; data: Array<Array<unknown>> }>,
): string => {
  const chunks: string[] = [];
  let outputLength = 0;
  let truncated = false;
  const outputLimit = MAX_EXTRACTED_TEXT_CHARS - SPREADSHEET_OUTPUT_RESERVE;
  const append = (text: string): boolean => {
    if (outputLength + text.length > outputLimit) {
      truncated = true;
      return false;
    }
    chunks.push(text);
    outputLength += text.length;
    return true;
  };

  outer: for (const sheet of sheets) {
    if (!append(`## Sheet: ${markdownCell(sheet.sheet)}\n\n`)) break;
    const columnCount = Math.min(
      MAX_SPREADSHEET_COLUMNS,
      sheet.data.reduce((max, row) => Math.max(max, row.length), 0),
    );
    if (columnCount === 0) {
      if (!append('_Empty sheet_\n\n')) break;
      continue;
    }

    if (!append(`| ${Array.from({ length: columnCount }, (_, index) => excelColumnName(index)).join(' | ')} |\n`)) break;
    if (!append(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |\n`)) break;

    for (const row of sheet.data) {
      const values = Array.from(
        { length: columnCount },
        (_, index) => markdownCell(row[index]),
      );
      if (!append(`| ${values.join(' | ')} |\n`)) break outer;
    }
    if (!append('\n')) break;
  }

  if (truncated) chunks.push('\n_Spreadsheet preview was truncated because it exceeded the document text limit._\n');
  return chunks.join('');
};

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
 *  - xlsx → Markdown tables for every sheet
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
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      raw = result.text || '';
    } finally {
      await parser.destroy();
    }
  } else if (SPREADSHEET_EXTENSIONS.has(ext)) {
    const { default: readXlsxFile } = await import('read-excel-file/node');
    const sheets = await readXlsxFile(buffer);
    raw = spreadsheetToMarkdown(sheets);
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
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
};
