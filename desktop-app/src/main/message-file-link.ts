import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function getMessageFilePath(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.startsWith('file:///')
    || !value[8] || value[8] === '/' || /[?#\\\x00-\x1f\x7f]/.test(value)) return undefined;

  try {
    const filePath = fileURLToPath(value);
    if (/[\x00-\x1f\x7f]/.test(filePath)) return undefined;

    // Require a local drive path on Windows, excluding UNC, device paths and alternate data streams.
    if (process.platform === 'win32' && !/^[A-Za-z]:\\[^:]+$/.test(filePath)) return undefined;
    if ((await stat(filePath)).isFile()) return filePath;
  } catch {
    // Malformed URL or unavailable file.
  }
  return undefined;
}
