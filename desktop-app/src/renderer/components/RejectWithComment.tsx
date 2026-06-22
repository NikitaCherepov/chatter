import React, { useState } from 'react';
import s from './RejectWithComment.module.scss';

type RejectWithCommentProps = {
  className?: string;
  onReject: (comment: string) => Promise<void> | void;
};

export function RejectWithComment({ className, onReject }: RejectWithCommentProps) {
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
          {sending ? 'Отклоняю...' : 'Отклонить'}
        </button>
        <button className={className} disabled={sending} onClick={() => setOpen(true)}>
          Отклонить с комментарием
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
        placeholder="Что изменить или почему отклонить?"
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
          {sending ? 'Отправляю...' : 'Отправить'}
        </button>
        <button className={s.cancelBtn} disabled={sending} onClick={() => setOpen(false)}>
          Назад
        </button>
      </div>
    </div>
  );
}
