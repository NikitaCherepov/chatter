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

export type SavedImage = {
  url: string;       // relative URL: /api/v1/images/abc123.webp
  filename: string;  // abc123.webp
};

/**
 * Save a thumbnail version of a user-uploaded image.
 * Returns the relative URL and filename.
 */
export const saveUserImageThumbnail = async (
  base64: string,
  mimeType?: string
): Promise<SavedImage> => {
  ensureUploadsDir();

  const buffer = Buffer.from(base64, 'base64');
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `${id}_thumb.webp`;
  const filepath = path.join(UPLOADS_DIR, filename);

  await sharp(buffer, { failOn: 'none' })
    .resize(THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toFile(filepath);

  return { url: `/api/v1/images/${filename}`, filename };
};

/**
 * Save a generated image as-is (no compression/resize).
 * Returns the relative URL and filename.
 */
export const saveGeneratedImage = async (
  base64: string
): Promise<SavedImage> => {
  ensureUploadsDir();

  const buffer = Buffer.from(base64, 'base64');
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `${id}.png`;
  const filepath = path.join(UPLOADS_DIR, filename);

  await fs.promises.writeFile(filepath, buffer);

  return { url: `/api/v1/images/${filename}`, filename };
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
export const filenameFromUrl = (url: string): string | null => {
  const match = url.match(/\/api\/v1\/images\/(.+)$/);
  return match ? match[1] : null;
};
