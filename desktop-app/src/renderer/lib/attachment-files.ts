import { prepareImageForUpload } from './imageCompression';
/* ── Image config ── */
export const ALLOWED_IMAGE_FORMATS: string[] = (() => {
  const raw = import.meta.env.VITE_ALLOWED_IMAGE_FORMATS || '';
  if (!raw.trim()) {
    return ['image/png', 'image/jpeg', 'image/webp'];
  }
  return raw.split(',').map((f: string) => f.trim()).filter(Boolean);
})();

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/svg+xml': 'SVG',
  'image/avif': 'AVIF',
  'image/tiff': 'TIFF',
};

export const IMAGE_FORMAT_LABELS: string = ALLOWED_IMAGE_FORMATS
  .map((mime) => MIME_TO_EXT[mime] || mime.split('/')[1]?.toUpperCase() || mime)
  .join(', ');

/* ── Document config ── */
export const ALLOWED_DOC_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'ini', 'toml', 'env', 'conf', 'cfg',
  'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'rb', 'php', 'pl', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1',
  'sql', 'graphql', 'gql',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'rtf', 'docx', 'pdf', 'xlsx',
];

export const MAX_DOC_SIZE = 5 * 1024 * 1024; // 5 MB

/* ── Types ── */
export type ImageItem = {
  file: File;
  preview: string;
  base64: string;
  mime_type: string;
  size_bytes: number;
};

export type DocumentItem = {
  file: File;
  base64: string;
  filename: string;
  size_bytes: number;
};

export type AttachmentProcessingError = {
  key: string;
  values?: Record<string, string | number>;
};

export async function prepareAttachmentFiles(
  files: FileList | File[],
  options: {
    currentImageCount: number;
    maxImageCount: number;
    currentImageBytes: number;
    maxTotalImageBytes: number;
  },
): Promise<{
  images: ImageItem[];
  documents: DocumentItem[];
  error?: AttachmentProcessingError;
}> {
  const images: ImageItem[] = [];
  const documents: DocumentItem[] = [];
  let error: AttachmentProcessingError | undefined;

  for (const file of Array.from(files)) {
    if (ALLOWED_IMAGE_FORMATS.includes(file.type)) {
      if (options.currentImageCount + images.length >= options.maxImageCount) {
        error = { key: 'attach.error.imageLimit', values: { count: options.maxImageCount } };
        break;
      }
      try {
        const prepared = await prepareImageForUpload(file);
        const pendingBytes = images.reduce((sum, image) => sum + image.size_bytes, 0);
        if (options.currentImageBytes + pendingBytes + prepared.size_bytes > options.maxTotalImageBytes) {
          URL.revokeObjectURL(prepared.preview);
          error = {
            key: 'attach.error.imageTotalTooLarge',
            values: { size: formatSize(options.maxTotalImageBytes) },
          };
          continue;
        }
        images.push(prepared);
      } catch {
        error = { key: 'attach.error.imagePrepare', values: { name: file.name } };
      }
      continue;
    }

    const ext = getExt(file.name);
    if (ALLOWED_DOC_EXTENSIONS.includes(ext)) {
      if (file.size > MAX_DOC_SIZE) {
        error = { key: 'attach.error.documentTooLarge', values: { name: file.name } };
        continue;
      }
      try {
        const base64 = await fileToBase64(file);
        documents.push({
          file,
          base64: base64.split(',')[1] || base64,
          filename: file.name,
          size_bytes: file.size,
        });
      } catch {
        error = { key: 'attach.error.read', values: { name: file.name } };
      }
      continue;
    }

    error = { key: 'attach.error.unsupported', values: { name: file.name } };
  }

  return { images, documents, error };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function selectedFileMime(name: string): string {
  const extension = getExt(name);
  const mimeTypes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rtf: 'application/rtf',
    json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'application/xml',
    html: 'text/html', htm: 'text/html', css: 'text/css', md: 'text/markdown', markdown: 'text/markdown',
  };
  return mimeTypes[extension] ?? (ALLOWED_DOC_EXTENSIONS.includes(extension) ? 'text/plain' : 'application/octet-stream');
}
