import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import s from './ConfirmDialog.module.scss';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  text: string;
  confirmLabel?: string;
  confirmTone?: 'danger' | 'primary';
  confirmFirst?: boolean;
  confirmDisabled?: boolean;
  input?: {
    value: string;
    placeholder?: string;
    maxLength?: number;
    onChange: (value: string) => void;
  };
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel,
  confirmTone = 'danger',
  confirmFirst = false,
  confirmDisabled = false,
  input,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const cancelButton = (
    <button className={s.confirmCancel} onClick={onCancel}>{t('common.cancel')}</button>
  );
  const confirmButton = (
    <button
      className={confirmTone === 'primary' ? s.confirmPrimary : s.confirmDanger}
      onClick={onConfirm}
      disabled={confirmDisabled}
    >
      {confirmLabel ?? t('common.delete')}
    </button>
  );
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
        {input && (
          <input
            className={s.confirmInput}
            value={input.value}
            placeholder={input.placeholder}
            maxLength={input.maxLength}
            autoFocus
            onChange={event => input.onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') onCancel();
              if (event.key === 'Enter' && !confirmDisabled) onConfirm();
            }}
          />
        )}
        <div className={s.confirmBtns}>
          {confirmFirst && confirmButton}
          {cancelButton}
          {!confirmFirst && confirmButton}
        </div>
      </motion.div>
    </motion.div>
  );
}
