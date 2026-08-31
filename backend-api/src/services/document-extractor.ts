import crypto from 'node:crypto';
import path from 'node:path';
import { db } from '../db.js';
import { callLiteAi } from './ai.js';
import {
  deleteAttachmentFile,
  resolveAttachmentFile,
  saveUserDocument,
} from './attachment-storage.js';
import { parseDocument, SUPPORTED_EXTENSIONS } from './document-parser.js';
import { countTokens } from './tokenizer.js';

const VIRTUAL_PAGE_CHARS = 6_000;
const BATCH_SIZE = 3;
const MAX_EXTRACTOR_FILE_SIZE = 25 * 1024 * 1024;

type FileRow = {
  id: number; user_id: number; name: string; storage_filename: string;
  mime_type: string; size_bytes: number; char_count: number;
  approximate_tokens: number; page_count: number; pages_json: string;
  created_at: number; updated_at: number;
};
type JobRow = {
  id: number; user_id: number; file_id: number; instruction: string;
  example_json: string; start_page: number; end_page: number;
  overlap_pages: number; auto_confirm: number; status: string; current_page: number;
  processed_batches: number; total_batches: number; error: string | null;
  created_at: number; updated_at: number;
};
type ItemRow = {
  id: number; job_id: number; data_json: string;
  status: 'incomplete' | 'review' | 'confirmed'; identity_key: string | null;
  source_pages: string; created_at: number; updated_at: number;
};

const now = () => Math.floor(Date.now() / 1000);
const parseJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const ext = (name: string) => path.extname(name).slice(1).toLowerCase();
const fileDto = (row: FileRow) => ({
  id: row.id, name: row.name, mime_type: row.mime_type, size_bytes: row.size_bytes,
  char_count: row.char_count, approximate_tokens: row.approximate_tokens,
  page_count: row.page_count, created_at: row.created_at, updated_at: row.updated_at,
});
const jobDto = (row: JobRow) => ({
  id: row.id, file_id: row.file_id, instruction: row.instruction,
  example: parseJson<Record<string, unknown>>(row.example_json, {}),
  start_page: row.start_page, end_page: row.end_page,
  overlap_pages: Boolean(row.overlap_pages),
  auto_confirm: Boolean(row.auto_confirm), status: row.status,
  current_page: row.current_page, processed_batches: row.processed_batches,
  total_batches: row.total_batches, error: row.error,
  created_at: row.created_at, updated_at: row.updated_at,
});
const itemDto = (row: ItemRow) => ({
  id: row.id, job_id: row.job_id,
  data: parseJson<Record<string, unknown>>(row.data_json, {}),
  status: row.status, identity_key: row.identity_key,
  source_pages: parseJson<number[]>(row.source_pages, []),
  created_at: row.created_at, updated_at: row.updated_at,
});

const splitVirtualPages = (text: string): string[] => {
  if (!text) return [''];
  const pages: string[] = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(text.length, position + VIRTUAL_PAGE_CHARS);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n\n', end), text.lastIndexOf('\n', end));
      if (boundary > position + VIRTUAL_PAGE_CHARS * 0.65) end = boundary;
    }
    pages.push(text.slice(position, end).trim());
    position = end;
    while (position < text.length && /\s/.test(text[position])) position += 1;
  }
  return pages.length ? pages : [''];
};

const parsePages = async (buffer: Buffer, name: string): Promise<string[]> => {
  if (ext(name) !== 'pdf') return splitVirtualPages(await parseDocument(buffer, name));
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const pages = result.pages.map(page => (page.text || '').trim());
    if (!pages.some(Boolean)) throw new Error('pdf_text_layer_required');
    return pages;
  } finally {
    await parser.destroy();
  }
};

export const createExtractionFile = async (
  userId: number,
  input: { name: string; mimeType?: string; buffer: Buffer },
) => {
  const name = path.basename((input.name || '').trim());
  if (!name) throw new Error('filename_required');
  if (!SUPPORTED_EXTENSIONS.has(ext(name))) throw new Error('unsupported_document_type');
  if (!input.buffer.length || input.buffer.length > MAX_EXTRACTOR_FILE_SIZE) {
    throw new Error('file_size_invalid');
  }
  const pages = await parsePages(input.buffer, name);
  const text = pages.join('\n\n');
  const saved = await saveUserDocument(input.buffer, name);
  try {
    const timestamp = now();
    const result = db.prepare(`
      INSERT INTO document_extraction_files (
        user_id, name, storage_filename, mime_type, size_bytes, char_count,
        approximate_tokens, page_count, pages_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, name, saved.filename, input.mimeType || 'application/octet-stream',
      saved.size_bytes, text.length, countTokens(text), pages.length,
      JSON.stringify(pages), timestamp, timestamp,
    );
    return fileDto(db.prepare('SELECT * FROM document_extraction_files WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as FileRow);
  } catch (error) {
    deleteAttachmentFile(saved.filename);
    throw error;
  }
};

export const listExtractionFiles = (userId: number) =>
  (db.prepare('SELECT * FROM document_extraction_files WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
    .all(userId) as FileRow[]).map(row => {
      const latest = db.prepare(
        'SELECT * FROM document_extraction_jobs WHERE user_id = ? AND file_id = ? ORDER BY id DESC LIMIT 1',
      ).get(userId, row.id) as JobRow | undefined;
      return { ...fileDto(row), latest_job: latest ? jobDto(latest) : null };
    });

export const renameExtractionFile = (userId: number, fileId: number, name: string) => {
  const value = (name || '').trim().slice(0, 200);
  return Boolean(value) && db.prepare(
    'UPDATE document_extraction_files SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(value, now(), fileId, userId).changes > 0;
};

export const deleteExtractionFile = (userId: number, fileId: number) => {
  const row = db.prepare('SELECT * FROM document_extraction_files WHERE id = ? AND user_id = ?')
    .get(fileId, userId) as FileRow | undefined;
  if (!row) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM document_extraction_items WHERE user_id = ? AND job_id IN (SELECT id FROM document_extraction_jobs WHERE file_id = ? AND user_id = ?)')
      .run(userId, fileId, userId);
    db.prepare('DELETE FROM document_extraction_jobs WHERE file_id = ? AND user_id = ?').run(fileId, userId);
    db.prepare('DELETE FROM document_extraction_files WHERE id = ? AND user_id = ?').run(fileId, userId);
  })();
  deleteAttachmentFile(row.storage_filename);
  return true;
};

export const resolveExtractionDownload = (userId: number, fileId: number) => {
  const row = db.prepare('SELECT * FROM document_extraction_files WHERE id = ? AND user_id = ?')
    .get(fileId, userId) as FileRow | undefined;
  if (!row) return null;
  const filepath = resolveAttachmentFile(row.storage_filename);
  return filepath ? { filepath, name: row.name, mimeType: row.mime_type } : null;
};

const meaningful = (value: unknown) =>
  value !== null && value !== undefined
  && (typeof value !== 'string' || value.trim().length > 0)
  && (!Array.isArray(value) || value.length > 0);

const isComplete = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value, key)));

const parseModelResult = (raw: string) => {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model_returned_invalid_json');
  const value = JSON.parse(cleaned.slice(start, end + 1)) as { complete?: unknown; incomplete?: unknown };
  return {
    complete: Array.isArray(value.complete) ? value.complete : [],
    incomplete: Array.isArray(value.incomplete) ? value.incomplete : [],
  };
};

const identityFor = (item: Record<string, unknown>, field: string) => {
  const value = item[field];
  return meaningful(value)
    ? `${field}:${JSON.stringify(value)}`.toLowerCase()
    : `hash:${crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex')}`;
};

const mergeRecords = (
  first: Record<string, unknown>,
  second: Record<string, unknown>,
) => {
  const merged = { ...first };
  for (const [key, value] of Object.entries(second)) {
    if (meaningful(value) || !meaningful(merged[key])) merged[key] = value;
  }
  return merged;
};

const saveComplete = (
  job: JobRow,
  item: Record<string, unknown>,
  identityField: string,
  sourcePages: number[],
) => {
  const identity = identityFor(item, identityField);
  const existing = db.prepare(`
    SELECT * FROM document_extraction_items
    WHERE user_id = ? AND job_id = ? AND identity_key = ? AND status != 'incomplete'
    ORDER BY id DESC LIMIT 1
  `).get(job.user_id, job.id, identity) as ItemRow | undefined;
  if (existing) {
    const merged = mergeRecords(
      parseJson<Record<string, unknown>>(existing.data_json, {}),
      item,
    );
    const pages = [...new Set([
      ...parseJson<number[]>(existing.source_pages, []),
      ...sourcePages,
    ])].sort((a, b) => a - b);
    db.prepare('UPDATE document_extraction_items SET data_json = ?, source_pages = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), JSON.stringify(pages), now(), existing.id);
    return;
  }
  db.prepare(`
    INSERT INTO document_extraction_items
      (user_id, job_id, data_json, status, identity_key, source_pages, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.user_id, job.id, JSON.stringify(item), job.auto_confirm ? 'confirmed' : 'review',
    identity, JSON.stringify(sourcePages), now(), now(),
  );
};

const replaceIncomplete = (
  job: JobRow,
  items: Record<string, unknown>[],
  identityField: string,
  sourcePages: number[],
) => {
  db.prepare("DELETE FROM document_extraction_items WHERE user_id = ? AND job_id = ? AND status = 'incomplete'")
    .run(job.user_id, job.id);
  const deduplicated = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const identity = identityFor(item, identityField);
    const previous = deduplicated.get(identity);
    deduplicated.set(identity, previous ? mergeRecords(previous, item) : item);
  }
  const insert = db.prepare(`
    INSERT INTO document_extraction_items
      (user_id, job_id, data_json, status, identity_key, source_pages, created_at, updated_at)
    VALUES (?, ?, ?, 'incomplete', ?, ?, ?, ?)
  `);
  for (const [identity, item] of deduplicated) {
    insert.run(
      job.user_id, job.id, JSON.stringify(item), identity,
      JSON.stringify(sourcePages), now(), now(),
    );
  }
};

const getBatchStarts = (start: number, end: number, overlapPages: boolean) => {
  const result: number[] = [];
  const step = BATCH_SIZE - (overlapPages ? 1 : 0);
  for (let page = start; page <= end; page += step) {
    result.push(page);
    if (page + BATCH_SIZE - 1 >= end) break;
  }
  return result;
};

const processJob = async (jobId: number) => {
  const job = db.prepare('SELECT * FROM document_extraction_jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined;
  if (!job || job.status !== 'pending') return;
  const file = db.prepare('SELECT * FROM document_extraction_files WHERE id = ? AND user_id = ?')
    .get(job.file_id, job.user_id) as FileRow | undefined;
  if (!file) return;
  const pages = parseJson<string[]>(file.pages_json, []);
  const example = parseJson<Record<string, unknown>>(job.example_json, {});
  const requiredKeys = Object.keys(example);
  const identityField = requiredKeys[0];
  const starts = getBatchStarts(job.start_page, job.end_page, Boolean(job.overlap_pages));
  db.prepare("UPDATE document_extraction_jobs SET status = 'processing', total_batches = ?, updated_at = ? WHERE id = ?")
    .run(starts.length, now(), jobId);
  try {
    for (let index = 0; index < starts.length; index += 1) {
      const current = db.prepare('SELECT * FROM document_extraction_jobs WHERE id = ?')
        .get(jobId) as JobRow | undefined;
      if (!current || current.status !== 'processing') return;
      const from = starts[index];
      const to = Math.min(job.end_page, from + BATCH_SIZE - 1);
      const pageNumbers = Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
      const pageText = pageNumbers
        .map(page => `--- PAGE ${page} ---\n${pages[page - 1] || ''}`)
        .join('\n\n');
      const incompleteRows = db.prepare(`
        SELECT * FROM document_extraction_items
        WHERE user_id = ? AND job_id = ? AND status = 'incomplete' ORDER BY id
      `).all(job.user_id, jobId) as ItemRow[];
      const previous = incompleteRows.map(row =>
        parseJson<Record<string, unknown>>(row.data_json, {}),
      );
      const raw = await callLiteAi(
        'You extract structured data from document pages. Return strictly one JSON object with exactly two array keys: "complete" and "incomplete". Use the example object as the required shape. Follow the extraction instruction when deciding whether an empty string, null, empty array, or empty object is a legitimate final value. Put an object in complete when every example field is present, its values satisfy the extraction instruction, and the source entry clearly ends in the supplied pages. Put cut-off or missing-field objects in incomplete. Continue and merge prior incomplete objects when their remaining text appears. Any prior incomplete object that cannot be completed from these pages must remain in incomplete unchanged. Never invent missing facts. Do not add prose or markdown.',
        `EXTRACTION INSTRUCTION:\n${job.instruction}\n\nEXAMPLE OBJECT:\n${job.example_json}\n\nPRIOR INCOMPLETE OBJECTS:\n${JSON.stringify(previous)}\n\nDOCUMENT PAGES:\n${pageText}`,
        {
          max_tokens: 8192,
          temperature: 0.1,
          accounting: { userId: job.user_id, route: 'utility:document-extractor' },
        },
      );
      const parsed = parseModelResult(raw);
      const complete: Record<string, unknown>[] = [];
      const incomplete: Record<string, unknown>[] = [];
      for (const candidate of parsed.complete) {
        if (isComplete(candidate, requiredKeys)) complete.push(candidate);
        else if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          incomplete.push(candidate as Record<string, unknown>);
        }
      }
      for (const candidate of parsed.incomplete) {
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          incomplete.push(candidate as Record<string, unknown>);
        }
      }
      db.transaction(() => {
        for (const item of complete) saveComplete(current, item, identityField, pageNumbers);
        replaceIncomplete(current, incomplete, identityField, pageNumbers);
        db.prepare(`
          UPDATE document_extraction_jobs
          SET current_page = ?, processed_batches = ?, updated_at = ? WHERE id = ?
        `).run(to, index + 1, now(), jobId);
      })();
    }
    db.prepare("UPDATE document_extraction_jobs SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'processing'")
      .run(now(), jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'extraction_failed';
    db.prepare("UPDATE document_extraction_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message.slice(0, 500), now(), jobId);
  }
};

export const createExtractionJob = (
  userId: number,
  input: {
    fileId: number; instruction: string; example: unknown;
    startPage?: number; endPage?: number; overlapPages?: boolean; autoConfirm?: boolean;
  },
) => {
  const file = db.prepare('SELECT * FROM document_extraction_files WHERE id = ? AND user_id = ?')
    .get(input.fileId, userId) as FileRow | undefined;
  if (!file) throw new Error('file_not_found');
  const instruction = (input.instruction || '').trim();
  if (!instruction || instruction.length > 8_000) throw new Error('instruction_invalid');
  if (!input.example || typeof input.example !== 'object'
    || Array.isArray(input.example) || !Object.keys(input.example).length) {
    throw new Error('example_object_required');
  }
  const exampleJson = JSON.stringify(input.example);
  if (exampleJson.length > 20_000) throw new Error('example_too_large');
  const startPage = Math.max(1, Math.floor(input.startPage || 1));
  const endPage = Math.min(file.page_count, Math.floor(input.endPage || file.page_count));
  if (startPage > endPage) throw new Error('page_range_invalid');
  const timestamp = now();
  const result = db.prepare(`
    INSERT INTO document_extraction_jobs (
      user_id, file_id, instruction, example_json, start_page, end_page,
      overlap_pages, auto_confirm, status, total_batches, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    userId, file.id, instruction, exampleJson, startPage, endPage,
    input.overlapPages === false ? 0 : 1,
    input.autoConfirm === false ? 0 : 1,
    getBatchStarts(startPage, endPage, input.overlapPages !== false).length,
    timestamp, timestamp,
  );
  const jobId = Number(result.lastInsertRowid);
  void processJob(jobId);
  return getExtractionJob(userId, jobId);
};

export const getExtractionJob = (userId: number, jobId: number) => {
  const job = db.prepare('SELECT * FROM document_extraction_jobs WHERE id = ? AND user_id = ?')
    .get(jobId, userId) as JobRow | undefined;
  if (!job) return null;
  const duplicateRows = db.prepare(`
    SELECT * FROM document_extraction_items
    WHERE job_id = ? AND user_id = ? AND status = 'incomplete'
    ORDER BY id DESC
  `).all(jobId, userId) as ItemRow[];
  const kept = new Map<string, ItemRow>();
  db.transaction(() => {
    for (const row of duplicateRows) {
      const key = row.identity_key || `data:${row.data_json}`;
      const existing = kept.get(key);
      if (!existing) {
        kept.set(key, row);
        continue;
      }
      const data = mergeRecords(
        parseJson<Record<string, unknown>>(row.data_json, {}),
        parseJson<Record<string, unknown>>(existing.data_json, {}),
      );
      const pages = [...new Set([
        ...parseJson<number[]>(row.source_pages, []),
        ...parseJson<number[]>(existing.source_pages, []),
      ])].sort((a, b) => a - b);
      db.prepare('UPDATE document_extraction_items SET data_json = ?, source_pages = ? WHERE id = ?')
        .run(JSON.stringify(data), JSON.stringify(pages), existing.id);
      db.prepare('DELETE FROM document_extraction_items WHERE id = ?').run(row.id);
      existing.data_json = JSON.stringify(data);
      existing.source_pages = JSON.stringify(pages);
    }
  })();
  const items = db.prepare(
    'SELECT * FROM document_extraction_items WHERE job_id = ? AND user_id = ? ORDER BY id',
  ).all(jobId, userId) as ItemRow[];
  return { ...jobDto(job), items: items.map(itemDto) };
};

export const listExtractionJobs = (userId: number, fileId: number) => {
  if (!db.prepare('SELECT 1 FROM document_extraction_files WHERE id = ? AND user_id = ?')
    .get(fileId, userId)) return null;
  return (db.prepare(
    'SELECT * FROM document_extraction_jobs WHERE file_id = ? AND user_id = ? ORDER BY id DESC',
  ).all(fileId, userId) as JobRow[]).map(jobDto);
};

export const updateExtractionItem = (
  userId: number,
  jobId: number,
  itemId: number,
  input: { data?: unknown; status?: 'review' | 'confirmed' },
) => {
  const row = db.prepare(
    'SELECT * FROM document_extraction_items WHERE id = ? AND job_id = ? AND user_id = ?',
  ).get(itemId, jobId, userId) as ItemRow | undefined;
  if (!row) return null;
  const data = input.data === undefined
    ? parseJson<Record<string, unknown>>(row.data_json, {})
    : input.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('item_object_required');
  }
  const status = input.status || row.status;
  if (!['incomplete', 'review', 'confirmed'].includes(status)) {
    throw new Error('item_status_invalid');
  }
  db.prepare(
    'UPDATE document_extraction_items SET data_json = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(JSON.stringify(data), status, now(), itemId, userId);
  return itemDto(db.prepare('SELECT * FROM document_extraction_items WHERE id = ?')
    .get(itemId) as ItemRow);
};

export const confirmExtractionItems = (
  userId: number,
  jobId: number,
  itemIds?: number[],
) => {
  if (!db.prepare('SELECT 1 FROM document_extraction_jobs WHERE id = ? AND user_id = ?')
    .get(jobId, userId)) return false;
  if (itemIds?.length) {
    const placeholders = itemIds.map(() => '?').join(',');
    db.prepare(`
      UPDATE document_extraction_items SET status = 'confirmed', updated_at = ?
      WHERE user_id = ? AND job_id = ? AND status = 'review' AND id IN (${placeholders})
    `).run(now(), userId, jobId, ...itemIds);
  } else {
    db.prepare(`
      UPDATE document_extraction_items SET status = 'confirmed', updated_at = ?
      WHERE user_id = ? AND job_id = ? AND status = 'review'
    `).run(now(), userId, jobId);
  }
  return true;
};

export const deleteExtractionItem = (userId: number, jobId: number, itemId: number) =>
  db.prepare(
    'DELETE FROM document_extraction_items WHERE id = ? AND job_id = ? AND user_id = ?',
  ).run(itemId, jobId, userId).changes > 0;

export const cancelExtractionJob = (userId: number, jobId: number) =>
  db.prepare(`
    UPDATE document_extraction_jobs
    SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('pending', 'processing')
  `).run(now(), jobId, userId).changes > 0;

// The response of an in-flight model call is unknown after a backend restart.
// Mark interrupted jobs clearly instead of leaving them permanently processing.
db.prepare(`
  UPDATE document_extraction_jobs
  SET status = 'failed', error = 'backend_restarted', updated_at = ?
  WHERE status IN ('pending', 'processing')
`).run(now());
