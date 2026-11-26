import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  cloneThemeStorageValue,
  validThemeStorageId,
  validThemeStorageKey,
  THEME_STORAGE_LIMITS,
  type ThemeStorageRequest,
  type ThemeStorageSnapshot,
} from './theme-storage-types';

/** Device-local state, deliberately outside the theme workspace and portable snapshots. */
export class ThemeStorage {
  private listeners = new Map<
    string,
    Set<(snapshot: ThemeStorageSnapshot, origin?: string) => void>
  >();
  constructor(readonly directory: string) {}
  read(id: string): ThemeStorageSnapshot {
    if (!validThemeStorageId(id)) throw new Error('theme_storage_unavailable');
    const file = path.join(this.directory, id + '.json');
    let text: string;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > THEME_STORAGE_LIMITS.totalBytes)
        throw new Error();
      text = fs.readFileSync(file, 'utf8');
    } catch (error: any) {
      if (error.code === 'ENOENT') return { revision: 0, values: {} };
      throw new Error('theme_storage_read_failed');
    }
    try {
      const data = JSON.parse(text);
      if (
        data.version !== 1 ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 0 ||
        !data.values ||
        typeof data.values !== 'object' ||
        Array.isArray(data.values) ||
        Object.keys(data.values).length > THEME_STORAGE_LIMITS.keys
      )
        throw new Error();
      for (const [key, value] of Object.entries(data.values)) {
        if (!validThemeStorageKey(key)) throw new Error();
        data.values[key] = cloneThemeStorageValue(value);
      }
      return { revision: data.revision, values: data.values };
    } catch {
      throw new Error('theme_storage_read_failed');
    }
  }
  request(id: string, request: ThemeStorageRequest, origin?: string): ThemeStorageSnapshot {
    if (!request || !['read', 'set', 'remove'].includes(request.operation))
      throw new Error('theme_storage_invalid_request');
    const current = this.read(id);
    if (request.operation === 'read') return current;
    if (
      !validThemeStorageKey(request.key) ||
      (request.revision !== undefined &&
        (!Number.isSafeInteger(request.revision) || request.revision < 0))
    )
      throw new Error('theme_storage_invalid_request');
    if (request.revision !== undefined && request.revision !== current.revision)
      throw new Error('theme_storage_conflict');
    const values = { ...current.values };
    if (request.operation === 'remove') delete values[request.key];
    else values[request.key] = cloneThemeStorageValue(request.value);
    if (JSON.stringify(values) === JSON.stringify(current.values)) return current;
    if (Object.keys(values).length > THEME_STORAGE_LIMITS.keys)
      throw new Error('theme_storage_too_many_keys');
    const snapshot = { revision: current.revision + 1, values };
    const text = JSON.stringify({ version: 1, ...snapshot });
    if (Buffer.byteLength(text) > THEME_STORAGE_LIMITS.totalBytes)
      throw new Error('theme_storage_full');
    const file = path.join(this.directory, id + '.json'),
      temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {
      throw new Error('theme_storage_write_failed');
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* Rename consumed it, or the write failed. */
      }
    }
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener(snapshot, origin);
      } catch {
        /* An isolated view may have closed. */
      }
    }
    return snapshot;
  }
  subscribe(id: string, listener: (snapshot: ThemeStorageSnapshot, origin?: string) => void) {
    if (!validThemeStorageId(id)) throw new Error('theme_storage_unavailable');
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
}
