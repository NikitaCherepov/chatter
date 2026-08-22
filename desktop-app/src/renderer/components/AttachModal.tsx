import React, { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { prepareImageForUpload } from '../lib/imageCompression';
import s from './AttachModal.module.scss';

/* ── Image config ── */
const ALLOWED_IMAGE_FORMATS: string[] = (() => {
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

const IMAGE_FORMAT_LABELS: string = ALLOWED_IMAGE_FORMATS
  .map((mime) => MIME_TO_EXT[mime] || mime.split('/')[1]?.toUpperCase() || mime)
  .join(', ');

/* ── Document config ── */
const ALLOWED_DOC_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'ini', 'toml', 'env', 'conf', 'cfg',
  'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'rb', 'php', 'pl', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1',
  'sql', 'graphql', 'gql',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'rtf', 'docx', 'pdf', 'xlsx',
];

const MAX_DOC_SIZE = 5 * 1024 * 1024; // 5 MB

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

type Props = {
  onClose: () => void;
  onAttach: (items: { images: ImageItem[]; documents: DocumentItem[] }) => void;
  currentImageCount: number;
  maxImageCount: number;
  currentImageBytes: number;
  maxTotalImageBytes: number;
};

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function AttachModal({
  onClose,
  onAttach,
  currentImageCount,
  maxImageCount,
  currentImageBytes,
  maxTotalImageBytes,
}: Props) {
  const { t } = useTranslation();
  const [images, setImages] = useState<ImageItem[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalCount = images.length + documents.length;

  const processFiles = async (files: FileList | File[]) => {
    setError('');
    const result = await prepareAttachmentFiles(files, {
      currentImageCount: currentImageCount + images.length,
      maxImageCount,
      currentImageBytes: currentImageBytes + images.reduce((sum, image) => sum + image.size_bytes, 0),
      maxTotalImageBytes,
    });

    if (result.images.length > 0) {
      setImages((prev) => [...prev, ...result.images]);
    }
    if (result.documents.length > 0) {
      setDocuments((prev) => [...prev, ...result.documents]);
    }
    if (result.error) {
      setError(t(result.error.key, result.error.values));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOver(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
    setError('');
  };

  const handleRemoveDoc = (index: number) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
    setError('');
  };

  const handleAttach = () => {
    if (totalCount > 0) {
      onAttach({ images, documents });
    }
  };

  const acceptAttr = [
    ...ALLOWED_IMAGE_FORMATS,
    ...ALLOWED_DOC_EXTENSIONS.map((e) => `.${e}`),
  ].join(',');

  return (
    <motion.div
      className={s.overlay}
      onClick={onClose}
      variants={overlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
        <motion.div
          className={s.modal}
          onClick={(e) => e.stopPropagation()}
          variants={modalVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <button className={s.closeBtn} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          <h2 className={s.title}>{t('attach.title')}</h2>

          <div
            className={s.dropZone}
            style={dragOver ? { opacity: 0.6, borderColor: 'var(--accent)', backgroundColor: 'var(--bg-input)' } : undefined}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className={s.dropIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </div>
            <span className={s.dropText}>{t('attach.drop')}</span>
            <span className={s.dropHint}>
              {t('attach.imageHint', {
                formats: IMAGE_FORMAT_LABELS,
                size: formatSize(maxTotalImageBytes),
              })}
            </span>
            <span className={s.dropHint}>
              {t('attach.documentHint')}
            </span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={acceptAttr}
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {error && <p className={s.errorText}>{error}</p>}

          {/* Image previews */}
          {images.length > 0 && (
            <div className={s.previews}>
              {images.map((img, i) => (
                <div key={`img-${i}`} className={s.previewItem}>
                  <img className={s.previewImg} src={img.preview} alt="" />
                  <button className={s.previewRemove} onClick={() => handleRemoveImage(i)}>
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Document list */}
          {documents.length > 0 && (
            <div className={s.docsList}>
              {documents.map((doc, i) => (
                <div key={`doc-${i}`} className={s.docItem}>
                  <div className={s.docIcon}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </div>
                  <div className={s.docInfo}>
                    <span className={s.docName}>{doc.filename}</span>
                    <span className={s.docSize}>{formatSize(doc.size_bytes)}</span>
                  </div>
                  <button className={s.docRemove} onClick={() => handleRemoveDoc(i)} title={t('common.delete')}>
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={s.footer}>
            <button className={s.btnCancel} onClick={onClose}>{t('common.cancel')}</button>
            <button className={s.btnAttach} disabled={totalCount === 0} onClick={handleAttach}>
              {t('attach.action', { count: totalCount })}
            </button>
          </div>
        </motion.div>
      </motion.div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
