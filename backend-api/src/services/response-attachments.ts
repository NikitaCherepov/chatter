import net from 'node:net';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import type { MessageAttachment, MessageImage } from '../types.js';
import { saveUserDocument } from './attachment-storage.js';
import { checkBotFilePermission } from './bot-file-policy.js';
import { parseDocument } from './document-parser.js';
import { saveExternalImage } from './image-storage.js';
import { resolveEmailAttachmentReference } from './mail.js';
import { saveTemporaryUserFile, TEMPORARY_FILE_TTL_SECONDS } from './temporary-files.js';
import { countTokens } from './tokenizer.js';

const MAX_RESPONSE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type ResponseFileSink = {
  images: MessageImage[];
  attachments: MessageAttachment[];
  sourceKeys: Set<string>;
};

type FileSource = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

const isPrivateAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().split('%')[0];
  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || parts[0] >= 224;
  }
  if (net.isIPv6(normalized)) {
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return true;
};

const validateRemoteUrl = async (value: string): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid_url');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('unsupported_url');
  }
  if (url.hostname.toLowerCase() === 'localhost') throw new Error('private_url_forbidden');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('private_url_forbidden');
  }
  return url;
};

const filenameFromHeaders = (response: Response, url: URL): string => {
  const disposition = response.headers.get('content-disposition') || '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  let candidate = '';
  try {
    candidate = utf8Match ? decodeURIComponent(utf8Match[1]) : (plainMatch?.[1] || '');
  } catch {
    candidate = '';
  }
  if (!candidate) {
    try {
      candidate = decodeURIComponent(url.pathname);
    } catch {
      candidate = url.pathname;
    }
  }
  candidate = path.basename(candidate || 'download');
  return candidate.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'download';
};

const downloadRemoteFile = async (value: string): Promise<FileSource> => {
  let url = await validateRemoteUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Chatter/1.0 file attachment downloader' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) throw new Error('too_many_or_invalid_redirects');
        await response.body?.cancel();
        url = await validateRemoteUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`download_failed_${response.status}`);
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > MAX_RESPONSE_FILE_BYTES) throw new Error('file_too_large');

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body as any) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_RESPONSE_FILE_BYTES) {
          controller.abort();
          throw new Error('file_too_large');
        }
        chunks.push(buffer);
      }
      return {
        buffer: Buffer.concat(chunks),
        filename: filenameFromHeaders(response, url),
        mimeType: (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('too_many_redirects');
};

export const saveTempFileForUse = async (
  userId: number,
  args: { file_ref?: unknown; url?: unknown; filename?: unknown },
): Promise<string> => {
  const fileRef = typeof args.file_ref === 'string' ? args.file_ref.trim() : '';
  const remoteUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (Boolean(fileRef) === Boolean(remoteUrl)) {
    return JSON.stringify({ status: 'error', message: 'Provide exactly one of file_ref or url.' });
  }

  const source = fileRef
    ? await resolveEmailAttachmentReference(userId, fileRef)
    : await downloadRemoteFile(remoteUrl);
  if (!source.buffer.length) throw new Error('empty_file');
  if (source.buffer.length > MAX_RESPONSE_FILE_BYTES) throw new Error('file_too_large');

  const allowedFile = checkBotFilePermission(
    args.filename,
    source.filename,
    source.mimeType,
    MAX_RESPONSE_FILE_BYTES,
  );
  if (!allowedFile) {
    const filename = path.basename(`${args.filename || source.filename || 'attachment'}`);
    return JSON.stringify({
      status: 'unsupported_file_type',
      filename,
      extension: path.extname(filename).slice(1).toLowerCase() || null,
    });
  }
  if (source.buffer.length > allowedFile.maxSizeBytes) {
    return JSON.stringify({
      status: 'file_too_large',
      filename: allowedFile.filename,
      size_bytes: source.buffer.length,
      max_size_bytes: allowedFile.maxSizeBytes,
    });
  }

  const saved = await saveTemporaryUserFile(
    userId,
    source.buffer,
    allowedFile.filename,
    allowedFile.mimeType,
  );
  return JSON.stringify({
    status: 'saved',
    filename: allowedFile.filename,
    mime_type: allowedFile.mimeType,
    size_bytes: saved.size_bytes,
    attachment_url: saved.url,
    expires_in_seconds: TEMPORARY_FILE_TTL_SECONDS,
    instruction: 'Use this exact relative attachment_url when another tool asks for a saved file.',
  });
};

export const attachFileToResponse = async (
  userId: number,
  args: { file_ref?: unknown; url?: unknown; filename?: unknown },
  sink: ResponseFileSink,
): Promise<string> => {
  const fileRef = typeof args.file_ref === 'string' ? args.file_ref.trim() : '';
  const remoteUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (Boolean(fileRef) === Boolean(remoteUrl)) {
    return JSON.stringify({ status: 'error', message: 'Provide exactly one of file_ref or url.' });
  }

  const sourceKey = fileRef ? `ref:${fileRef}` : `url:${remoteUrl}`;
  if (sink.sourceKeys.has(sourceKey)) {
    return JSON.stringify({ status: 'already_attached' });
  }

  const source = fileRef
    ? await resolveEmailAttachmentReference(userId, fileRef)
    : await downloadRemoteFile(remoteUrl);
  if (!source.buffer.length) throw new Error('empty_file');
  if (source.buffer.length > MAX_RESPONSE_FILE_BYTES) throw new Error('file_too_large');
  const allowedFile = checkBotFilePermission(
    args.filename,
    source.filename,
    source.mimeType,
    MAX_RESPONSE_FILE_BYTES,
  );
  if (!allowedFile) {
    const filename = path.basename(`${args.filename || source.filename || 'attachment'}`);
    return JSON.stringify({
      status: 'unsupported_file_type',
      filename,
      extension: path.extname(filename).slice(1).toLowerCase() || null,
    });
  }
  if (source.buffer.length > allowedFile.maxSizeBytes) {
    return JSON.stringify({
      status: 'file_too_large',
      filename: allowedFile.filename,
      size_bytes: source.buffer.length,
      max_size_bytes: allowedFile.maxSizeBytes,
    });
  }

  const savedImage = allowedFile.kind === 'image'
    ? await saveExternalImage(source.buffer)
    : null;
  if (savedImage) {
    const image: MessageImage = { url: savedImage.url, type: 'external' };
    sink.images.push(image);
    sink.sourceKeys.add(sourceKey);
    return JSON.stringify({
      status: 'attached',
      kind: 'image',
      filename: allowedFile.filename,
      mime_type: savedImage.mime_type,
      size_bytes: source.buffer.length,
      url: savedImage.url,
    });
  }

  let extractedText = '';
  if (allowedFile.kind === 'document') {
    try {
      extractedText = await parseDocument(source.buffer, allowedFile.filename);
    } catch (error: any) {
      return JSON.stringify({
        status: 'file_parse_failed',
        filename: allowedFile.filename,
        message: error?.message || String(error),
      });
    }
  }
  const saved = await saveUserDocument(source.buffer, allowedFile.filename);
  const attachment: MessageAttachment = {
    name: allowedFile.filename,
    size_bytes: saved.size_bytes,
    mime_type: allowedFile.mimeType,
    extracted_text: extractedText,
    url: saved.url,
    filename: saved.filename,
    char_count: extractedText.length,
    estimated_tokens: extractedText ? countTokens(extractedText) : 0,
  };
  sink.attachments.push(attachment);
  sink.sourceKeys.add(sourceKey);
  return JSON.stringify({
    status: 'attached',
    kind: 'file',
    filename: allowedFile.filename,
    mime_type: allowedFile.mimeType,
    size_bytes: saved.size_bytes,
    url: saved.url,
  });
};
