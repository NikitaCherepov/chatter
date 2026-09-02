import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from '../db.js';
import { deleteAttachmentFile, resolveAttachmentFile, saveUserDocument } from './attachment-storage.js';

export const TEMPORARY_FILE_TTL_SECONDS = 60 * 60;

type TemporaryFileRow = {
  user_id: number;
  filename: string;
  url: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  expires_at: number;
};

const deleteRowsAndFiles = (rows: Array<Pick<TemporaryFileRow, 'filename'>>) => {
  for (const row of rows) deleteAttachmentFile(row.filename);
};

export const cleanupExpiredTemporaryFiles = (): number => {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT filename FROM temporary_user_files WHERE expires_at <= ?')
    .all(now) as Array<{ filename: string }>;
  if (!rows.length) return 0;
  db.prepare('DELETE FROM temporary_user_files WHERE expires_at <= ?').run(now);
  deleteRowsAndFiles(rows);
  return rows.length;
};

export const saveTemporaryUserFile = async (
  userId: number,
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<TemporaryFileRow> => {
  cleanupExpiredTemporaryFiles();
  const saved = await saveUserDocument(buffer, name);
  const now = Math.floor(Date.now() / 1000);
  const row: TemporaryFileRow = {
    user_id: userId,
    filename: saved.filename,
    url: saved.url,
    name,
    mime_type: mimeType || 'application/octet-stream',
    size_bytes: saved.size_bytes,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    expires_at: now + TEMPORARY_FILE_TTL_SECONDS,
  };
  try {
    db.prepare(`
      INSERT INTO temporary_user_files (
        user_id, filename, url, name, mime_type, size_bytes, sha256, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.user_id,
      row.filename,
      row.url,
      row.name,
      row.mime_type,
      row.size_bytes,
      row.sha256,
      now,
      row.expires_at,
    );
  } catch (error) {
    deleteAttachmentFile(saved.filename);
    throw error;
  }
  return row;
};

export const resolveTemporaryUserFile = (
  userId: number,
  url: string,
): (TemporaryFileRow & { filepath: string }) | null => {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(`
    SELECT user_id, filename, url, name, mime_type, size_bytes, sha256, expires_at
    FROM temporary_user_files
    WHERE user_id = ? AND url = ?
  `).get(userId, url) as TemporaryFileRow | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM temporary_user_files WHERE user_id = ? AND url = ?').run(userId, url);
    deleteAttachmentFile(row.filename);
    return null;
  }
  const filepath = resolveAttachmentFile(row.filename);
  if (!filepath) {
    db.prepare('DELETE FROM temporary_user_files WHERE user_id = ? AND url = ?').run(userId, url);
    return null;
  }
  try {
    const stat = fs.statSync(filepath);
    if (!stat.isFile() || stat.size !== row.size_bytes) {
      db.prepare('DELETE FROM temporary_user_files WHERE user_id = ? AND url = ?').run(userId, url);
      deleteAttachmentFile(row.filename);
      return null;
    }
  } catch {
    db.prepare('DELETE FROM temporary_user_files WHERE user_id = ? AND url = ?').run(userId, url);
    return null;
  }
  return { ...row, filepath };
};

cleanupExpiredTemporaryFiles();
const cleanupTimer = setInterval(cleanupExpiredTemporaryFiles, 10 * 60 * 1000);
cleanupTimer.unref();
