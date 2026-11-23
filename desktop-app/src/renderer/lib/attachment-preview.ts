import type * as api from './api';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { AppearanceDocumentPreview, AppearanceDocumentPage } from '../../main/appearance-shell-types';
export const isPdfAttachment = (attachment: api.MessageAttachment) =>
  attachment.mime_type === 'application/pdf'
  || attachment.name.toLowerCase().endsWith('.pdf');

export const isDocxAttachment = (attachment: api.MessageAttachment) =>
  attachment.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  || attachment.name.toLowerCase().endsWith('.docx');

export const isSpreadsheetAttachment = (attachment: api.MessageAttachment) =>
  attachment.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  || attachment.name.toLowerCase().endsWith('.xlsx');

export const formatTextAttachment = (attachment: api.MessageAttachment): string => {
  const isJson = attachment.mime_type === 'application/json'
    || attachment.name.toLowerCase().endsWith('.json');
  if (!isJson) return attachment.extracted_text;

  try {
    return JSON.stringify(JSON.parse(attachment.extracted_text), null, 2);
  } catch {
    return attachment.extracted_text;
  }
};

const ATTACHMENT_PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const attachmentPreviewCache = new Map<string, Uint8Array>();
let attachmentPreviewCacheBytes = 0;

export const loadAttachmentBytes = async (src: string, cacheKey: string): Promise<Uint8Array> => {
  cacheKey = src + '\u0000' + cacheKey;
  const cached = attachmentPreviewCache.get(cacheKey);
  if (cached) {
    attachmentPreviewCache.delete(cacheKey);
    attachmentPreviewCache.set(cacheKey, cached);
    return cached;
  }

  const response = await fetch(src);
  if (!response.ok) throw new Error(`Attachment request failed with status ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength <= ATTACHMENT_PREVIEW_CACHE_MAX_BYTES) {
    // Concurrent page requests may finish fetching the same source together.
    const previous = attachmentPreviewCache.get(cacheKey);
    if (previous) {
      attachmentPreviewCache.delete(cacheKey);
      attachmentPreviewCacheBytes -= previous.byteLength;
    }
    while (
      attachmentPreviewCacheBytes + bytes.byteLength > ATTACHMENT_PREVIEW_CACHE_MAX_BYTES
      && attachmentPreviewCache.size > 0
    ) {
      const oldestKey = attachmentPreviewCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = attachmentPreviewCache.get(oldestKey);
      attachmentPreviewCache.delete(oldestKey);
      attachmentPreviewCacheBytes -= oldest?.byteLength || 0;
    }
    attachmentPreviewCache.set(cacheKey, bytes);
    attachmentPreviewCacheBytes += bytes.byteLength;
  }

  return bytes;
};

const DOCX_ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'blockquote', 'pre', 'code', 'img',
]);

export const sanitizeDocxHtml = (rawHtml: string) => {
  const document = new DOMParser().parseFromString(rawHtml, 'text/html');
  const elements = Array.from(document.body.querySelectorAll('*'));

  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    if (!DOCX_ALLOWED_TAGS.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    const imageSource = tagName === 'img' ? element.getAttribute('src') : null;
    const imageAlt = tagName === 'img' ? element.getAttribute('alt') : null;
    for (const attribute of Array.from(element.attributes)) {
      element.removeAttribute(attribute.name);
    }

    if (tagName === 'img') {
      if (!imageSource?.startsWith('data:image/')) {
        element.remove();
      } else {
        element.setAttribute('src', imageSource);
        if (imageAlt) element.setAttribute('alt', imageAlt);
      }
    }
  }

  return document.body.innerHTML;
};

async function withPdf<T>(src: string, key: string, use: (pdf: import('pdfjs-dist').PDFDocumentProxy) => Promise<T>): Promise<T> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const bytes = await loadAttachmentBytes(src, key);
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try { return await use(pdf); } finally { await pdf.destroy(); }
}

export async function readAttachmentPreview(file: api.MessageAttachment, src: string): Promise<AppearanceDocumentPreview> {
  const common = { name: file.name, mimeType: file.mime_type, sizeBytes: file.size_bytes, text: file.extracted_text ?? '' };
  if (isPdfAttachment(file)) return withPdf(src, file.filename, async pdf => ({ ...common, kind: 'pdf', pageCount: pdf.numPages }));
  if (isDocxAttachment(file)) {
    const [module, bytes] = await Promise.all([import('mammoth'), loadAttachmentBytes(src, file.filename)]);
    const mammoth = module.default;
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer as ArrayBuffer },
      { convertImage: mammoth.images.dataUri, externalFileAccess: false });
    return { ...common, kind: 'docx', html: sanitizeDocxHtml(result.value) };
  }
  if (isSpreadsheetAttachment(file)) return { ...common, kind: 'spreadsheet' };
  return { ...common, kind: file.extracted_text ? 'text' : 'unsupported', text: formatTextAttachment(file) || '' };
}

export async function renderAttachmentPage(file: api.MessageAttachment, src: string, pageNumber: number, width: number): Promise<AppearanceDocumentPage> {
  if (!isPdfAttachment(file)) throw new Error('attachment_not_pdf');
  return withPdf(src, file.filename, async pdf => {
    if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error('attachment_page_unavailable');
    const page = await pdf.getPage(pageNumber), natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.max(128, Math.min(1600, width)) / natural.width });
    if (viewport.height > 8192) throw new Error('attachment_page_too_large');
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d'); if (!context) throw new Error('attachment_canvas_unavailable');
    try {
      await page.render({ canvasContext: context, viewport }).promise;
      return { source: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, page: pageNumber, pageCount: pdf.numPages };
    } finally { page.cleanup(); canvas.width = 0; canvas.height = 0; }
  });
}

