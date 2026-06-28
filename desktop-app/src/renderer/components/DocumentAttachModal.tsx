import React, { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import s from './DocumentAttachModal.module.scss';

const ALLOWED_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'ini', 'toml', 'env', 'conf', 'cfg',
  'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'rb', 'php', 'pl', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1',
  'sql', 'graphql', 'gql',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'rtf', 'docx', 'pdf',
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export type DocumentItem = {
  file: File;
  base64: string;
  filename: string;
  size_bytes: number;
};

type Props = {
  onClose: () => void;
  onAttach: (documents: DocumentItem[]) => void;
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

export function DocumentAttachModal({ onClose, onAttach }: Props) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getExt = (name: string): string => {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
  };

  const processFiles = async (files: FileList | File[]) => {
    setError('');
    const valid: DocumentItem[] = [];
    const fileArr = Array.from(files);

    for (const file of fileArr) {
      const ext = getExt(file.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setError(`Неподдерживаемый формат: ${file.name} (.${ext || '?'})`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`Файл слишком большой: ${file.name} (макс. 5 МБ)`);
        continue;
      }

      try {
        const base64 = await fileToBase64(file);
        valid.push({
          file,
          base64: base64.split(',')[1] || base64,
          filename: file.name,
          size_bytes: file.size,
        });
      } catch {
        setError(`Не удалось прочитать: ${file.name}`);
      }
    }

    if (valid.length > 0) {
      setDocuments((prev) => [...prev, ...valid]);
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
    setDocuments((prev) => prev.filter((_, i) => i !== index));
    setError('');
  };

  const handleAttach = () => {
    if (documents.length > 0) {
      onAttach(documents);
    }
  };

  const acceptAttr = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

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

        <h2 className={s.title}>Прикрепить документы</h2>

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
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <span className={s.dropText}>Нажмите для выбора или перетащите файлы</span>
          <span className={s.dropHint}>
            txt, md, json, csv, pdf, docx, код… &bull; макс. 5 МБ на файл
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

        {documents.length > 0 && (
          <div className={s.docsList}>
            {documents.map((doc, i) => (
              <div key={i} className={s.docItem}>
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
                <button className={s.docRemove} onClick={() => handleRemove(i)} title="Удалить">
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={s.footer}>
          <button className={s.btnCancel} onClick={onClose}>Отмена</button>
          <button className={s.btnAttach} disabled={documents.length === 0} onClick={handleAttach}>
            Прикрепить ({documents.length})
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
