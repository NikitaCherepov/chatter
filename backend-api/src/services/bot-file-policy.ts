import path from 'node:path';
import { MAX_RAW_FILE_SIZE } from './attachment-storage.js';
import { guessMimeType, SUPPORTED_EXTENSIONS } from './document-parser.js';

const BOT_IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif',
  'tif', 'tiff', 'heif', 'heic', 'jp2', 'jxl',
]);

const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/xml': 'xml',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/heif': 'heif',
  'image/heic': 'heic',
  'image/jp2': 'jp2',
  'image/jxl': 'jxl',
};

const IMAGE_MIME_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heif: 'image/heif',
  heic: 'image/heic',
  jp2: 'image/jp2',
  jxl: 'image/jxl',
};

export type AllowedBotFile = {
  filename: string;
  extension: string;
  kind: 'image' | 'document';
  mimeType: string;
  maxSizeBytes: number;
};

const safeFilename = (requested: unknown, fallback: string): string => {
  const value = typeof requested === 'string' ? requested.trim() : '';
  const base = path.basename(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
  return base || 'attachment';
};

export const checkBotFilePermission = (
  requestedFilename: unknown,
  fallbackFilename: string,
  sourceMimeType: string,
  maxImageSizeBytes: number,
): AllowedBotFile | null => {
  let filename = safeFilename(requestedFilename, fallbackFilename);
  const normalizedMimeType = sourceMimeType.toLowerCase();
  if (!path.extname(filename)) {
    const inferredExtension = MIME_EXTENSION[normalizedMimeType];
    if (inferredExtension) filename = `${filename}.${inferredExtension}`;
  }

  const extension = path.extname(filename).slice(1).toLowerCase();
  if (BOT_IMAGE_EXTENSIONS.has(extension)) {
    return {
      filename,
      extension,
      kind: 'image',
      mimeType: IMAGE_MIME_TYPE[extension] || normalizedMimeType || 'application/octet-stream',
      maxSizeBytes: maxImageSizeBytes,
    };
  }
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;

  return {
    filename,
    extension,
    kind: 'document',
    mimeType: normalizedMimeType && normalizedMimeType !== 'application/octet-stream'
      ? normalizedMimeType
      : guessMimeType(filename),
    maxSizeBytes: MAX_RAW_FILE_SIZE,
  };
};
