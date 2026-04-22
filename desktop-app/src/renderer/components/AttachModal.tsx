import React, { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import s from './AttachModal.module.scss';

const ALLOWED_FORMATS: string[] = (() => {
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

const FORMAT_LABELS: string = ALLOWED_FORMATS
  .map((mime) => MIME_TO_EXT[mime] || mime.split('/')[1]?.toUpperCase() || mime)
  .join(', ');

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

type ImageItem = {
  file: File;
  preview: string;
  base64: string;
  mime_type: string;
};

type Props = {
  onClose: () => void;
  onAttach: (images: ImageItem[]) => void;
  currentCount: number;
  maxCount: number;
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

export function AttachModal({ onClose, onAttach, currentCount, maxCount }: Props) {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const remaining = maxCount - currentCount;

  const processFiles = async (files: FileList | File[]) => {
    setError('');
    const valid: ImageItem[] = [];
    const fileArr = Array.from(files);

    for (const file of fileArr) {
      if (!ALLOWED_FORMATS.includes(file.type)) {
        setError(`Неподдерживаемый формат: ${file.name}`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`Файл слишком большой: ${file.name} (макс. 20 МБ)`);
        continue;
      }
      if (images.length + valid.length >= remaining) {
        setError(`Максимум ${maxCount} изображений для вашего плана`);
        break;
      }

      try {
        const base64 = await fileToBase64(file);
        valid.push({
          file,
          preview: URL.createObjectURL(file),
          base64: base64.split(',')[1] || base64,
          mime_type: file.type,
        });
      } catch {
        setError(`Не удалось прочитать: ${file.name}`);
      }
    }

    if (valid.length > 0) {
      setImages((prev) => [...prev, ...valid]);
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

  const handleRemove = (index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
    setError('');
  };

  const handleAttach = () => {
    if (images.length > 0) {
      onAttach(images);
    }
  };

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

          <h2 className={s.title}>Прикрепить изображения</h2>

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
            <span className={s.dropText}>Нажмите для выбора или перетащите файлы</span>
            <span className={s.dropHint}>
              {FORMAT_LABELS} &bull; макс. 20 МБ на файл
            </span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_FORMATS.join(',')}
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {error && <p className={s.errorText}>{error}</p>}

          {images.length > 0 && (
            <div className={s.previews}>
              {images.map((img, i) => (
                <div key={i} className={s.previewItem}>
                  <img className={s.previewImg} src={img.preview} alt="" />
                  <button className={s.previewRemove} onClick={() => handleRemove(i)}>
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={s.footer}>
            <button className={s.btnCancel} onClick={onClose}>Отмена</button>
            <button className={s.btnAttach} disabled={images.length === 0} onClick={handleAttach}>
              Прикрепить ({images.length})
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

export type { ImageItem };
