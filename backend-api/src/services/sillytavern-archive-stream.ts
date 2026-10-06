import fs from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type { Readable } from 'node:stream';

export type ArchiveEntry = { name: string; size: number; data: Buffer };
export const BACKUP_UPLOAD_LIMIT = 256 * 1024 * 1024;
const EXTRACTED_LIMIT = 512 * 1024 * 1024;
const ENTRY_LIMIT = 32 * 1024 * 1024;
export const BACKUP_RESERVE = 64 * 1024 * 1024;

export function availableBytes(directory: string): number {
  const stat = fs.statfsSync(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

export function assertBackupSpace(directory: string, required: number): void {
  if (availableBytes(directory) < required + BACKUP_RESERVE) throw new Error('sillytavern_backup_insufficient_space');
}

/** ZIP paths are never used as filesystem paths. Extracted files have generated names. */
export async function extractBackupStream(input: Readable, directory: string, supported: (name: string) => boolean): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  const open = new Set<number>();
  let received = 0;
  let extracted = 0;
  let count = 0;
  let tail = Buffer.alloc(0);
  let failure: Error | null = null;
  const unzip = new Unzip(file => {
    if (++count > 5000) throw new Error('sillytavern_backup_too_many_files');
    // Validate every path, even entries we will ignore.
    const name = file.name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error('sillytavern_backup_invalid_path');
    if (names.has(name.toLowerCase())) throw new Error('sillytavern_backup_duplicate_path');
    names.add(name.toLowerCase());
    if (!supported(name)) {
      entries.push({ name, size: 0, data: Buffer.alloc(0) });
      // An unstarted fflate entry buffers its compressed chunks. Consume ignored
      // entries too, discarding output and enforcing the decompressed-byte budget.
      if (file.originalSize && file.originalSize > ENTRY_LIMIT) throw new Error('sillytavern_backup_entry_too_large');
      let ignoredSize = 0;
      file.ondata = (error, chunk) => {
        if (failure) return;
        if (error) { failure = error; return; }
        ignoredSize += chunk.length;
        extracted += chunk.length;
        if (ignoredSize > ENTRY_LIMIT || extracted > EXTRACTED_LIMIT) failure = new Error('sillytavern_backup_extracted_too_large');
      };
      file.start();
      return;
    }
    if (file.originalSize && file.originalSize > ENTRY_LIMIT) throw new Error('sillytavern_backup_entry_too_large');
    const target = path.join(directory, String(count));
    const fd = fs.openSync(target, 'wx');
    open.add(fd);
    let size = 0;
    const entry: ArchiveEntry = { name, size: 0, get data() { return fs.readFileSync(target); } };
    entries.push(entry);
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { failure = error; return; }
      size += chunk.length;
      extracted += chunk.length;
      if (size > ENTRY_LIMIT || extracted > EXTRACTED_LIMIT) {
        failure = new Error('sillytavern_backup_extracted_too_large');
        return;
      }
      try {
        assertBackupSpace(directory, chunk.length);
        fs.writeSync(fd, chunk);
        entry.size = size;
        if (final) {
          if (file.originalSize !== undefined && size !== file.originalSize) throw new Error('sillytavern_backup_invalid_zip');
          fs.closeSync(fd); open.delete(fd);
        }
      } catch (error) { failure = error as Error; }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      received += chunk.length;
      tail = Buffer.concat([tail, chunk]).subarray(-65557);
      if (received > BACKUP_UPLOAD_LIMIT) throw new Error('sillytavern_backup_too_large');
      // Bound synchronous decompression bursts independently of incoming chunk size.
      for (let offset = 0; offset < chunk.length; offset += 1024) {
        unzip.push(chunk.subarray(offset, offset + 1024), false);
        if (failure) throw failure;
      }
    }
    unzip.push(new Uint8Array(), true);
    if (failure) throw failure;
    if (!received || !entries.length || open.size) throw new Error('sillytavern_backup_invalid_zip');
    // Require a complete, single-volume ZIP (including the central directory).
    // fflate's streaming parser alone can accept an archive cut off after its files.
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0 || tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0
      || tail.readUInt16LE(eocd + 8) !== count || tail.readUInt16LE(eocd + 10) !== count
      || tail.readUInt32LE(eocd + 12) + tail.readUInt32LE(eocd + 16) !== received - tail.length + eocd) {
      throw new Error('sillytavern_backup_invalid_zip');
    }
    return entries;
  } catch (error: any) {
    if (error?.message?.startsWith('sillytavern_backup_')) throw error;
    throw new Error('sillytavern_backup_invalid_zip');
  } finally {
    for (const fd of open) fs.closeSync(fd);
  }
}
