import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import dotenv from 'dotenv';

dotenv.config();

const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.resolve(__dirname, '../../uploads')
);

const THUMBNAIL_MAX_WIDTH = 1920;
const THUMBNAIL_MAX_HEIGHT = 1080;
const THUMBNAIL_QUALITY = 80;

/** Ensure uploads directory exists */
const ensureUploadsDir = () => {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
};

export type SavedImageFile = {
  url: string;       // relative URL: /api/v1/images/abc123.webp
  filename: string;  // abc123.webp
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
};

export type SaveImageFileOptions = {
  transform?: 'preserve' | 'thumbnail';
};

const DISPLAY_IMAGE_FORMATS: Record<string, { extension: string; mimeType: string }> = {
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  png: { extension: 'png', mimeType: 'image/png' },
  webp: { extension: 'webp', mimeType: 'image/webp' },
  gif: { extension: 'gif', mimeType: 'image/gif' },
  avif: { extension: 'avif', mimeType: 'image/avif' },
};
const CONVERTIBLE_IMAGE_FORMATS = new Set(['tiff', 'heif', 'heic', 'jp2', 'jxl']);

/**
 * The only physical image writer. Ownership and lifetime live in media-assets.ts;
 * this module is deliberately limited to validating and writing bytes.
 */
export const saveImageFile = async (
  data: Buffer | string,
  options: SaveImageFileOptions = {},
): Promise<SavedImageFile | null> => {
  ensureUploadsDir();

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
  if (!buffer.length) return null;

  let format = '';
  let width: number | null = null;
  let height: number | null = null;
  try {
    const metadata = await sharp(buffer, { failOn: 'none', animated: true, limitInputPixels: 60_000_000 }).metadata();
    format = `${metadata.format || ''}`.toLowerCase();
    width = metadata.width ?? null;
    height = metadata.height ?? null;
    if ((metadata.width || 0) * (metadata.height || 0) > 60_000_000) return null;
  } catch {
    return null;
  }
  if (!format || (!DISPLAY_IMAGE_FORMATS[format] && !CONVERTIBLE_IMAGE_FORMATS.has(format))) return null;

  const id = crypto.randomBytes(12).toString('hex');
  if (options.transform === 'thumbnail') {
    const filename = `${id}_thumb.webp`;
    const info = await sharp(buffer, { failOn: 'none', limitInputPixels: 60_000_000 })
      .resize(THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toFile(path.join(UPLOADS_DIR, filename));
    return {
      url: `/api/v1/images/${filename}`,
      filename,
      mime_type: 'image/webp',
      width: info.width,
      height: info.height,
      size_bytes: info.size,
    };
  }

  const displayFormat = DISPLAY_IMAGE_FORMATS[format];
  if (displayFormat) {
    const filename = `${id}.${displayFormat.extension}`;
    await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), buffer);
    return {
      url: `/api/v1/images/${filename}`,
      filename,
      mime_type: displayFormat.mimeType,
      width,
      height,
      size_bytes: buffer.length,
    };
  }

  const filename = `${id}.webp`;
  const info = await sharp(buffer, { failOn: 'none', limitInputPixels: 60_000_000 })
    .webp({ quality: 90 })
    .toFile(path.join(UPLOADS_DIR, filename));
  return {
    url: `/api/v1/images/${filename}`,
    filename,
    mime_type: 'image/webp',
    width: info.width,
    height: info.height,
    size_bytes: info.size,
  };
};

/**
 * Get absolute filepath for a given filename.
 * Returns null if file doesn't exist.
 */
export const resolveImageFile = (filename: string): string | null => {
  // Prevent path traversal
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filepath)) return null;
  return filepath;
};

/**
 * Get uploads directory path (for static serving).
 */
export const getUploadsDir = (): string => {
  ensureUploadsDir();
  return UPLOADS_DIR;
};

/**
 * Delete an image file from disk by filename.
 * Best-effort: silently ignores errors.
 */
export const deleteImageFile = (filename: string): void => {
  try {
    const safeName = path.basename(filename);
    const filepath = path.join(UPLOADS_DIR, safeName);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch { /* best-effort */ }
};

/**
 * Extract filename from a URL like /api/v1/images/abc123.webp
 */
export const filenameFromUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const match = url.match(/\/(?:api\/v1\/images|uploads)\/([^/?#]+)(?:[?#].*)?$/);
  return match ? path.basename(match[1]) : null;
};
