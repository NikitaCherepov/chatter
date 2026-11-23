import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** File access is limited to the exact selection made in the system picker. Paths never enter a theme. */
export class AttachmentPicker {
  private selections = new Map<number, { id: string; expires: number; files: { path: string; size: number; modified: number }[] }>();
  async choose(owner: number, choose: () => Promise<string[]>) {
    const selection = { id: randomUUID(), expires: Date.now() + 5 * 60 * 1000, files: [] as { path: string; size: number; modified: number }[] };
    this.selections.set(owner, selection);
    const paths = await choose();
    if (this.selections.get(owner) !== selection) return { canceled: true, files: [] };
    if (!paths.length) { this.selections.delete(owner); return { canceled: true, files: [] }; }
    const files = await Promise.all(paths.map(async file => { const stat = await fs.stat(file); if (!stat.isFile()) throw new Error('attachment_not_file');
      return { path: file, size: stat.size, modified: stat.mtimeMs }; }));
    if (this.selections.get(owner) !== selection) return { canceled: true, files: [] };
    selection.files = files;
    return { canceled: false, selectionId: selection.id, files: files.map((file, index) => ({ index, name: path.basename(file.path), size: file.size })) };
  }
  async read(owner: number, selectionId: string, index: number): Promise<ArrayBuffer> {
    const selection = this.selections.get(owner);
    if (!selection || selection.id !== selectionId || selection.expires < Date.now() || !Number.isSafeInteger(index) || index < 0 || !selection.files[index])
      throw new Error('attachment_selection_expired');
    const file = selection.files[index], handle = await fs.open(file.path, 'r');
    try {
      const stat = await handle.stat();
      // Same raw-image ceiling as prepareImageForUpload. Documents have a tighter preparation limit.
      if (stat.size > 50 * 1024 * 1024) throw new Error('attachment_source_too_large');
      if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.modified) throw new Error('attachment_file_changed');
      const bytes = Buffer.alloc(file.size); let offset = 0;
      while (offset < bytes.length) { const chunk = await handle.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
      const after = await handle.stat();
      if (offset !== file.size || after.size !== file.size || after.mtimeMs !== file.modified) throw new Error('attachment_file_changed');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } finally { await handle.close(); }
  }
  release(owner: number, selectionId?: string) {
    if (!selectionId || this.selections.get(owner)?.id === selectionId) this.selections.delete(owner);
  }
}
