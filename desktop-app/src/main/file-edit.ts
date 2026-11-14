import { promises as fs, type Stats } from 'node:fs';
import { extname } from 'node:path';

type FileEditPayload = {
  start_line: number;
  end_line: number;
  new_content: string;
  expected_content: string;
  expected_file_version: string;
};

const pendingEdits = new Set<string>();
const version = (stat: Stats) => `${stat.size}:${stat.mtimeMs}`;
const eolPattern = /\r\n|\n|\r/;
const lineEnding = (line: string) => line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';

async function validateCssEdit(filePath: string, before: string, after: string) {
  if (extname(filePath).toLowerCase() !== '.css') return;
  const { format } = await import('prettier');
  try {
    await format(after, { parser: 'css' });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    try {
      await format(before, { parser: 'css' });
    } catch (previousError) {
      // Let an edit repair an already invalid stylesheet in multiple steps.
      if (previousError instanceof SyntaxError) return;
      throw previousError;
    }
    const detail = error.message.split('\n', 1)[0];
    throw new Error(`CSS syntax check failed. No changes written. ${detail} Check whether both fragments include the same boundary lines.`);
  }
}

export async function editFileLines(filePath: string, payload: FileEditPayload) {
  const {
    start_line: startLine, end_line: endLine, new_content: newContent,
    expected_content: expectedContent, expected_file_version: expectedFileVersion,
  } = payload;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      startLine < 1 || endLine < startLine - 1) {
    throw new Error('file_edit_invalid_range');
  }
  if (typeof expectedContent !== 'string' || !expectedFileVersion) {
    throw new Error('file_edit_snapshot_required');
  }
  if (typeof newContent !== 'string') throw new Error('file_edit_invalid_replacement');

  const resolved = await fs.realpath(filePath);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (pendingEdits.has(key)) throw new Error('file_changed_since_preview');
  pendingEdits.add(key);
  try {
    const checkVersion = async () => {
      if (version(await fs.stat(resolved)) !== expectedFileVersion) {
        throw new Error('file_changed_since_preview');
      }
    };
    await checkVersion();
    const raw = await fs.readFile(resolved, 'utf8');
    const lines = raw.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
    if (startLine > lines.length + 1 || endLine > lines.length) {
      throw new Error('file_edit_range_out_of_bounds');
    }

    const startIndex = startLine - 1;
    const selected = lines.slice(startIndex, endLine);
    const actualContent = selected.map((line) => line.slice(0, line.length - lineEnding(line).length)).join('\n');
    if (actualContent !== expectedContent.replace(/\r\n?/g, '\n')) {
      throw new Error('file_changed_since_preview');
    }

    const before = lines.slice(0, startIndex).join('');
    const after = lines.slice(endLine).join('');
    const eol = lines[startIndex]?.match(eolPattern)?.[0] ?? raw.match(eolPattern)?.[0] ?? '\n';
    const replacementLines = newContent === '' ? [] : newContent.split(eolPattern);
    let replacement = replacementLines.join(eol);
    if (replacementLines.length) {
      if (before && !lineEnding(before)) replacement = eol + replacement;
      replacement += selected.length ? lineEnding(selected[selected.length - 1]) : after ? eol : '';
    }
    const updated = before + replacement + after;
    await validateCssEdit(filePath, raw, updated);
    await checkVersion();
    await fs.writeFile(resolved, updated, 'utf8');

    return {
      ok: true,
      lines_removed: selected.length,
      lines_added: replacementLines.length,
      total_lines_before: lines.length,
      total_lines_after: lines.length - selected.length + replacementLines.length,
    };
  } finally {
    pendingEdits.delete(key);
  }
}
