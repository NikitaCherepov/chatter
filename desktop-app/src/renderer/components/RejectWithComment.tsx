import React, { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import s from './RejectWithComment.module.scss';
import { ConfirmationCardContext } from './ConfirmationCard';

type RejectWithCommentProps = {
  className?: string;
  onReject: (comment: string) => Promise<void> | void;
  disabled?: boolean;
};

export function RejectWithComment({ className, onReject, disabled = false }: RejectWithCommentProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const card = useContext(ConfirmationCardContext);
  const rejectRef = useRef(onReject);
  rejectRef.current = onReject;
  useEffect(() => card?.registerReject(text => rejectRef.current(text)));
  if (card) return <>
    <button type="button" className={className} disabled={disabled || card.busy}
      onClick={() => { void card.run(() => rejectRef.current('')).catch(() => {}); }}>{t('review.reject')}</button>
    <button type="button" className={className} disabled={disabled || card.busy}
      onClick={() => card.requestComment(text => rejectRef.current(text))}>{t('review.rejectWithComment')}</button>
  </>;


  if (!open) {
    return (
      <>
        <button
          className={className}
          disabled={disabled || sending}
          onClick={async () => {
            setSending(true);
            try {
              await onReject('');
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? t('review.rejecting') : t('review.reject')}
        </button>
        <button className={className} disabled={disabled || sending} onClick={() => setOpen(true)}>
          {t('review.rejectWithComment')}
        </button>
      </>
    );
  }

  return (
    <div className={s.rejectBox}>
      <textarea
        className={s.rejectInput}
        value={comment}
        disabled={disabled || sending}
        onChange={(event) => setComment(event.target.value)}
        placeholder={t('review.commentPlaceholder')}
        rows={3}
        autoFocus
      />
      <div className={s.rejectActions}>
        <button
          className={s.sendBtn}
          disabled={disabled || sending}
          onClick={async () => {
            setSending(true);
            try {
              await onReject(comment.trim());
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? t('common.sending') : t('common.send')}
        </button>
        <button className={s.cancelBtn} disabled={disabled || sending} onClick={() => setOpen(false)}>
          {t('common.back')}
        </button>
      </div>
    </div>
  );
}
