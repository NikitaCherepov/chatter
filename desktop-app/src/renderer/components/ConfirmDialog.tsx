import { motion } from 'framer-motion';
import s from './ConfirmDialog.module.scss';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  text: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ open, title, text, confirmLabel = 'Удалить', onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <motion.div
      key="confirm-dialog"
      className={s.overlay}
      onClick={onCancel}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
      variants={{
        hidden: { opacity: 0 },
        visible: { opacity: 1 },
        exit: { opacity: 0 },
      }}
      initial="hidden"
      animate={open ? 'visible' : 'hidden'}
      exit="exit"
    >
      <motion.div
        className={s.confirmDialog}
        onClick={(e) => e.stopPropagation()}
        variants={{
          hidden: { opacity: 0, y: 16 },
          visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
          exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
        }}
        initial="hidden"
        animate={open ? 'visible' : 'hidden'}
        exit="exit"
      >
        <div className={s.confirmTitle}>{title}</div>
        <div className={s.confirmText}>{text}</div>
        <div className={s.confirmBtns}>
          <button className={s.confirmCancel} onClick={onCancel}>Отмена</button>
          <button className={s.confirmDanger} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
