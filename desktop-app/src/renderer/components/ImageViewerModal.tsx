import { motion } from 'framer-motion';
import s from './ImageViewerModal.module.scss';

type Props = {
  src: string;
  alt?: string;
  downloadLabel: string;
  closeLabel: string;
  deleteLabel?: string;
  onClose: () => void;
  onDownload: () => void;
  onDelete?: () => void;
  aboveNewspaper?: boolean;
};

export function ImageViewerModal({ src, alt = '', downloadLabel, closeLabel, deleteLabel, onClose, onDownload, onDelete, aboveNewspaper = false }: Props) {
  return <motion.div
    className={`${s.overlay} ${aboveNewspaper ? s.aboveNewspaper : ''}`}
    role="dialog"
    aria-modal="true"
    aria-label={alt || closeLabel}
    onClick={onClose}
    variants={{ hidden: { opacity: 0 }, visible: { opacity: 1 }, exit: { opacity: 0 } }}
    initial="hidden"
    animate="visible"
    exit="exit"
  >
    <button className={`${s.download} ${onDelete ? '' : s.downloadOnly}`} type="button" onClick={event => { event.stopPropagation(); onDownload(); }} title={downloadLabel} aria-label={downloadLabel}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
    {onDelete && <button className={s.delete} type="button" onClick={event => { event.stopPropagation(); onDelete(); }} title={deleteLabel} aria-label={deleteLabel}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>}
    <button className={s.close} type="button" onClick={event => { event.stopPropagation(); onClose(); }} title={closeLabel} aria-label={closeLabel}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
    <img className={s.image} src={src} alt={alt} onClick={event => event.stopPropagation()} />
  </motion.div>;
}
