import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import {
  deleteImageFile,
  filenameFromUrl,
  resolveImageFile,
  saveImageFile,
  type SaveImageFileOptions,
} from './image-storage.js';

export type MediaRetention = 'temporary' | 'persistent';

export type MediaAsset = {
  id: number;
  user_id: number;
  storage_filename: string;
  local_url: string;
  mime_type: string;
  kind: string;
  retention: MediaRetention;
  source_url: string | null;
  source_page_url: string | null;
  credit: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number;
  metadata_json: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type SavedMediaAsset = MediaAsset & { url: string };

const DEFAULT_TEMPORARY_TTL_SECONDS = 60 * 60;

export const saveImageAsset = async (input: {
  userId: number;
  data: Buffer | string;
  retention?: MediaRetention;
  kind?: string;
  ttlSeconds?: number;
  transform?: SaveImageFileOptions['transform'];
  sourceUrl?: string | null;
  sourcePageUrl?: string | null;
  credit?: string | null;
  metadata?: unknown;
}): Promise<SavedMediaAsset> => {
  pruneExpiredMediaAssets();
  const retention = input.retention ?? 'temporary';
  const saved = await saveImageFile(input.data, { transform: input.transform ?? 'preserve' });
  if (!saved) throw new Error('image_format_not_supported');

  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, Math.floor(input.ttlSeconds ?? DEFAULT_TEMPORARY_TTL_SECONDS));
  const expiresAt = retention === 'temporary' ? now + ttlSeconds : null;
  const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);

  try {
    const inserted = db.prepare(`
      INSERT INTO media_assets (
        user_id, storage_filename, local_url, mime_type, kind, retention,
        source_url, source_page_url, credit, width, height, size_bytes,
        metadata_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.userId,
      saved.filename,
      saved.url,
      saved.mime_type,
      input.kind?.trim() || 'image',
      retention,
      input.sourceUrl?.trim() || null,
      input.sourcePageUrl?.trim() || null,
      input.credit?.trim() || null,
      saved.width,
      saved.height,
      saved.size_bytes,
      metadataJson,
      expiresAt,
      now,
      now,
    );
    const asset = db.prepare('SELECT * FROM media_assets WHERE id = ?')
      .get(Number(inserted.lastInsertRowid)) as MediaAsset;
    return { ...asset, url: asset.local_url };
  } catch (error) {
    deleteImageFile(saved.filename);
    throw error;
  }
};

export const getMediaAssetByFilename = (filename: string): MediaAsset | null => {
  const safeFilename = path.basename(filename);
  return (db.prepare('SELECT * FROM media_assets WHERE storage_filename = ?')
    .get(safeFilename) as MediaAsset | undefined) ?? null;
};

export const getMediaAssetById = (assetId: number): MediaAsset | null =>
  (db.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as MediaAsset | undefined) ?? null;

export const getMediaAssetByUrl = (url: string): MediaAsset | null => {
  const filename = filenameFromUrl(url);
  return filename ? getMediaAssetByFilename(filename) : null;
};

export const getReusableMediaAssetBySourceUrl = (
  userId: number,
  sourceUrl: string,
): MediaAsset | null => {
  pruneExpiredMediaAssets();
  const rows = db.prepare(`
    SELECT * FROM media_assets
    WHERE user_id = ? AND source_url = ?
    ORDER BY id DESC
  `).all(userId, sourceUrl) as MediaAsset[];
  const asset = rows.find(item => Boolean(resolveImageFile(item.storage_filename))) ?? null;
  if (!asset || asset.retention !== 'temporary') return asset;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE media_assets
    SET expires_at = MAX(COALESCE(expires_at, 0), ?), updated_at = ?
    WHERE id = ? AND retention = 'temporary'
  `).run(now + DEFAULT_TEMPORARY_TTL_SECONDS, now, asset.id);
  return getMediaAssetById(asset.id);
};

/** Register a pre-registry file without rewriting or copying it. */
export const registerExistingImageAsset = (
  userId: number,
  url: string,
  kind = 'legacy',
): MediaAsset | null => {
  const filename = filenameFromUrl(url);
  if (!filename) return null;
  const existing = getMediaAssetByFilename(filename);
  if (existing) return existing;
  const filepath = resolveImageFile(filename);
  if (!filepath) return null;

  const extension = path.extname(filename).toLowerCase();
  const mimeType = extension === '.png' ? 'image/png'
    : extension === '.webp' ? 'image/webp'
      : extension === '.gif' ? 'image/gif'
        : extension === '.avif' ? 'image/avif'
          : 'image/jpeg';
  const now = Math.floor(Date.now() / 1000);
  const sizeBytes = fs.statSync(filepath).size;
  db.prepare(`
    INSERT OR IGNORE INTO media_assets (
      user_id, storage_filename, local_url, mime_type, kind, retention,
      size_bytes, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'persistent', ?, NULL, ?, ?)
  `).run(userId, filename, url, mimeType, kind, sizeBytes, now, now);
  return getMediaAssetByFilename(filename);
};

export const attachMediaAsset = (input: {
  assetId: number;
  entityType: string;
  entityId: number;
  slot?: string;
}): void => {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO media_asset_references (asset_id, entity_type, entity_id, slot, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.assetId, input.entityType, input.entityId, input.slot?.trim() || 'default', now);
    db.prepare(`
      UPDATE media_assets
      SET retention = 'persistent', expires_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, input.assetId);
  })();
};

export const attachImageUrlsToEntity = (input: {
  userId: number;
  urls: string[];
  entityType: string;
  entityId: number;
}): void => {
  input.urls.forEach((url, index) => {
    const asset = getMediaAssetByUrl(url) ?? registerExistingImageAsset(input.userId, url);
    if (!asset) return;
    attachMediaAsset({
      assetId: asset.id,
      entityType: input.entityType,
      entityId: input.entityId,
      slot: `image:${index}`,
    });
  });
};

export const detachImageUrlFromEntity = (input: {
  url: string;
  entityType: string;
  entityId: number;
}): void => {
  const asset = getMediaAssetByUrl(input.url);
  if (!asset) return;
  db.prepare(`
    DELETE FROM media_asset_references
    WHERE asset_id = ? AND entity_type = ? AND entity_id = ?
  `).run(asset.id, input.entityType, input.entityId);
};

export const removeMediaReferencesForEntity = (entityType: string, entityId: number): number[] => {
  const rows = db.prepare(`
    SELECT DISTINCT asset_id FROM media_asset_references
    WHERE entity_type = ? AND entity_id = ?
  `).all(entityType, entityId) as Array<{ asset_id: number }>;
  db.prepare('DELETE FROM media_asset_references WHERE entity_type = ? AND entity_id = ?')
    .run(entityType, entityId);
  return rows.map(row => row.asset_id);
};

export const deleteMediaAssetIfUnreferenced = (assetId: number): boolean => {
  const referenced = db.prepare('SELECT 1 FROM media_asset_references WHERE asset_id = ? LIMIT 1')
    .get(assetId);
  if (referenced) return false;
  const asset = db.prepare('SELECT storage_filename FROM media_assets WHERE id = ?')
    .get(assetId) as { storage_filename: string } | undefined;
  if (!asset) return false;
  db.prepare('DELETE FROM media_assets WHERE id = ?').run(assetId);
  deleteImageFile(asset.storage_filename);
  return true;
};

export const deleteMediaAssetByFilenameIfUnreferenced = (filename: string): boolean => {
  const asset = getMediaAssetByFilename(filename);
  if (!asset) return false;
  return deleteMediaAssetIfUnreferenced(asset.id);
};

export const pruneExpiredMediaAssets = (now = Math.floor(Date.now() / 1000)): number => {
  const rows = db.prepare(`
    SELECT id FROM media_assets
    WHERE retention = 'temporary' AND expires_at IS NOT NULL AND expires_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM media_asset_references r WHERE r.asset_id = media_assets.id
      )
  `).all(now) as Array<{ id: number }>;
  let deleted = 0;
  for (const row of rows) if (deleteMediaAssetIfUnreferenced(row.id)) deleted += 1;
  return deleted;
};
