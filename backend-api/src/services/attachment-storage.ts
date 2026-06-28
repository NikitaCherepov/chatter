import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.resolve(__dirname, '../../uploads')
);

/** Hard limit on raw uploaded file size: 5 MB */
export const MAX_RAW_FILE_SIZE = 5 * 1024 * 1024;

/** Absolute ceiling on extracted text length (chars) to protect the server during parsing */
export const MAX_EXTRACTED_TEXT_CHARS = 500_000;

/** Ensure uploads directory exists */
const ensureUploadsDir = () => {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
};

export type SavedDocument = {
  url: string;       // /api/v1/attachments/<filename>
  filename: string;  // <id>_<sanitized_orig_name>.<ext>
  size_bytes: number;
};

/**
 * Sanitize original filename: keep ascii alnum, dot, dash, underscore.
 */
const sanitizeName = (name: string): string => {
  const base = path.basename(name);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 80) || 'document';
};

/**
 * Save a user-uploaded document to disk (no transformations).
 * Original extension is preserved.
 */
export const saveUserDocument = async (
  buffer: Buffer,
  originalName: string
): Promise<SavedDocument> => {
  ensureUploadsDir();

  const id = crypto.randomBytes(12).toString('hex');
  const safeName = sanitizeName(originalName);
  const filename = `${id}_${safeName}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  await fs.promises.writeFile(filepath, buffer);

  return {
    url: `/api/v1/attachments/${filename}`,
    filename,
    size_bytes: buffer.length,
  };
};

/**
 * Get absolute filepath for a given attachment filename.
 * Returns null if file doesn't exist. Path-traversal protected.
 */
export const resolveAttachmentFile = (filename: string): string | null => {
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filepath)) return null;
  return filepath;
};

/**
 * Delete an attachment file from disk.
 * No-op if file doesn't exist.
 */
export const deleteAttachmentFile = (filename: string): void => {
  try {
    const safeName = path.basename(filename);
    const filepath = path.join(UPLOADS_DIR, safeName);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch {
    // best-effort
  }
};
