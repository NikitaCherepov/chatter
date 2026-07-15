import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import s from './RejectWithComment.module.scss';

type RejectWithCommentProps = {
  className?: string;
  onReject: (comment: string) => Promise<void> | void;
};

export function RejectWithComment({ className, onReject }: RejectWithCommentProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  if (!open) {
    return (
      <>
        <button
          className={className}
          disabled={sending}
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
        <button className={className} disabled={sending} onClick={() => setOpen(true)}>
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
        onChange={(event) => setComment(event.target.value)}
        placeholder={t('review.commentPlaceholder')}
        rows={3}
        autoFocus
      />
      <div className={s.rejectActions}>
        <button
          className={s.sendBtn}
          disabled={sending}
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
        <button className={s.cancelBtn} disabled={sending} onClick={() => setOpen(false)}>
          {t('common.back')}
        </button>
      </div>
    </div>
  );
}
