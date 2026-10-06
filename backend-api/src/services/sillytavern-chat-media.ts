import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import type { MessageImage, MessageAttachment } from '../types.js';
import { saveImageAsset, attachMediaAsset, deleteMediaAssetIfUnreferenced, getReusableMediaAssetBySourceUrl } from './media-assets.js';
import { saveUserDocument, deleteAttachmentFile, MAX_RAW_FILE_SIZE } from './attachment-storage.js';
import { guessMimeType, parseDocument } from './document-parser.js';
import type { ArchiveEntry } from './sillytavern-archive-stream.js';

type Reference = { url: string; name: string; image: boolean };
export function attachmentReferences(extra: any): Reference[] {
  if (!extra || typeof extra !== 'object') return [];
  const refs: Reference[] = [];
  const add = (value: any, image: boolean) => {
    const url = typeof value === 'string' ? value : value?.url;
    if (typeof url !== 'string' || !url.trim()) return;
    refs.push({ url, name: value?.name || value?.title || '', image });
  };
  if (extra.image) add(extra.image, true);
  for (const item of Array.isArray(extra.media) ? extra.media : []) add(item, item?.type === 'image');
  if (extra.file) add(extra.file, false);
  for (const item of Array.isArray(extra.files) ? extra.files : []) add(item, false);
  return refs.filter((ref, index) => refs.findIndex(other => other.url === ref.url) === index);
}

function localPath(url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  try {
    const normalized = decodeURIComponent(url.split(/[?#]/)[0]).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
    if (normalized.split('/').includes('..') || normalized.includes('\0')) return null;
    return normalized;
  } catch { return null; }
}

export function findArchiveAttachment(entries: ArchiveEntry[], url: string): ArchiveEntry | null {
  const name = localPath(url);
  if (!name) return null;
  const candidates = entries.filter(entry => entry.name === name || entry.name.endsWith('/' + name));
  // Never guess by basename: two characters can have equally named images.
  return candidates.length === 1 ? candidates[0] : null;
}

export function chatMediaRows(raw: string): any[] {
  const rows = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (rows.length && !('mes' in rows[0])) rows.shift();
  return rows.filter(row => typeof row.mes === 'string' && (row.mes.trim() || attachmentReferences(row.extra).length));
}

export async function importChatAttachments(userId: number, chatId: number, raw: string, entries: ArchiveEntry[], onProgress?: (done: number, total: number) => void) {
  const result = { images: 0, files: 0, missing: 0, errors: 0 };
  const rows = chatMediaRows(raw);
  const messages = db.prepare('SELECT id, role, active_variant_index FROM chat_messages WHERE user_id = ? AND chat_id = ? ORDER BY timeline_index, id')
    .all(userId, chatId) as Array<{ id: number; role: string; active_variant_index: number }>;
  if (rows.length !== messages.length) return { ...result, errors: 1 };
  for (let index = 0; index < rows.length; index++) {
    onProgress?.(index, rows.length);
    const row = rows[index];
    const message = messages[index];
    const variants = message.role === 'assistant'
      ? db.prepare('SELECT variant_index, content, images, attachments FROM chat_message_variants WHERE message_id = ? ORDER BY variant_index').all(message.id) as any[]
      : [{ variant_index: 0, content: row.mes, ...db.prepare('SELECT images, attachments FROM chat_messages WHERE id = ?').get(message.id) as any }];
    const validSwipeIndexes = Array.isArray(row.swipes) ? row.swipes.map((text: any, i: number) => typeof text === 'string' && text.trim() ? i : -1).filter((i: number) => i >= 0) : [];
    const sourceVariants = validSwipeIndexes.length ? validSwipeIndexes.map((i: number) => row.swipes[i]) : [row.mes];
    let sourceActive = sourceVariants.indexOf(row.mes);
    const requested = Number(row.swipe_id);
    if (Number.isSafeInteger(requested) && requested >= 0 && requested < sourceVariants.length && sourceVariants[requested] === row.mes) sourceActive = requested;
    if (sourceActive < 0) sourceActive = sourceVariants.length;
    for (const variant of variants) {
      // Active message extra is authoritative. Inactive swipes use their own metadata only.
      // Source selection is independent of the user's current selection in Chatter.
      const swipeExtra = row.swipe_info?.[validSwipeIndexes[variant.variant_index]]?.extra;
      const extra = variant.variant_index === sourceActive && attachmentReferences(row.extra).length ? row.extra : swipeExtra || (message.role === 'user' ? row.extra : undefined);
      const images: Array<MessageImage & { import_source?: string }> = JSON.parse(variant.images || '[]');
      const files: Array<MessageAttachment & { import_source?: string }> = JSON.parse(variant.attachments || '[]');
      for (const ref of attachmentReferences(extra)) {
        if ([...images, ...files].some(item => item.import_source === ref.url)) continue;
        const entry = findArchiveAttachment(entries, ref.url);
        if (!entry) { result.missing++; continue; }
        let assetId: number | null = null;
        let documentFilename: string | null = null;
        try {
          const data = entry.data;
          if (ref.image) {
            const sourceUrl = 'sillytavern:sha256:' + createHash('sha256').update(data).digest('hex');
            const existing = getReusableMediaAssetBySourceUrl(userId, sourceUrl);
            const saved = existing ? { ...existing, url: existing.local_url } : await saveImageAsset({ userId, data, sourceUrl, kind: 'sillytavern_chat', metadata: { source_file: entry.name } });
            assetId = saved.id;
            images.push({ url: saved.url, type: message.role === 'user' ? 'user_photo' : 'external', import_source: ref.url });
          } else {
            // ST often stores converted text under files/*.txt; parse actual bytes by actual extension.
            let extracted = '';
            if (data.length <= MAX_RAW_FILE_SIZE) {
              try { extracted = await parseDocument(data, path.basename(entry.name)); } catch { /* Preserve unsupported originals without claiming extracted text. */ }
            }
            const saved = await saveUserDocument(data, path.basename(entry.name));
            documentFilename = saved.filename;
            files.push({ name: ref.name || path.basename(entry.name), size_bytes: data.length, mime_type: guessMimeType(entry.name), extracted_text: extracted, url: saved.url, filename: saved.filename, import_source: ref.url });
          }
          const imagesJson = images.length ? JSON.stringify(images) : null;
          const filesJson = files.length ? JSON.stringify(files) : null;
          db.transaction(() => {
            if (message.role === 'assistant') db.prepare('UPDATE chat_message_variants SET images = ?, attachments = ? WHERE message_id = ? AND variant_index = ?').run(imagesJson, filesJson, message.id, variant.variant_index);
            if (variant.variant_index === message.active_variant_index) db.prepare('UPDATE chat_messages SET images = ?, attachments = ? WHERE id = ?').run(imagesJson, filesJson, message.id);
            if (assetId !== null) attachMediaAsset({ assetId, entityType: 'chat_message', entityId: message.id, slot: 'variant:' + variant.variant_index + ':' + images.length });
          })();
          if (ref.image) result.images++; else result.files++;
        } catch {
          if (ref.image && assetId !== null) images.pop();
          if (!ref.image && documentFilename) files.pop();
          if (assetId !== null) deleteMediaAssetIfUnreferenced(assetId);
          if (documentFilename) deleteAttachmentFile(documentFilename);
          result.errors++;
        }
      }
    }
  }
  return result;
}
