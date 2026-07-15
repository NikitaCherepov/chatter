import { useTranslation } from 'react-i18next';
import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import s from './DocumentsTool.module.scss';

type Props = {
  chatId: number | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(unix: number, locale: string): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function DocumentsTool({ chatId }: Props) {
  const { t, i18n } = useTranslation();
  const [attachments, setAttachments] = useState<api.ChatAttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    try {
      const res = await api.getChatAttachments(id);
      setAttachments(res.attachments || []);
    } catch (err) {
      console.error('[documents] Failed to load:', err);
      setAttachments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (chatId) {
      load(chatId);
    } else {
      setAttachments([]);
    }
  }, [chatId, load]);

  const handleDelete = async (item: api.ChatAttachmentItem) => {
    if (!chatId) return;
    setDeletingId(item.filename);
    try {
      await api.deleteAttachment(chatId, item.message_id, item.filename);
      setAttachments((prev) => prev.filter((a) => !(a.filename === item.filename && a.message_id === item.message_id)));
      setConfirmId(null);
    } catch (err) {
      console.error('[documents] Failed to delete:', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = (item: api.ChatAttachmentItem) => {
    const url = api.resolveImageUrl(item.url);
    // Use same download mechanism as images
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!chatId) {
    return (
      <div className={s.root}>
        <div className={s.empty}>{t('tools.documents.selectChat')}</div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      {attachments.length === 0 && !loading ? (
        <div className={s.empty}>{t('tools.documents.empty')}</div>
      ) : (
        attachments.map((item, i) => {
          const itemKey = `${item.message_id}-${item.filename}-${i}`;
          const isConfirming = confirmId === itemKey;
          const isDeleting = deletingId === item.filename;

          if (isConfirming) {
            return (
              <div key={itemKey} className={s.confirmDelete}>
                <span className={s.confirmText}>{t('tools.documents.deleteQuestion', { name: item.name })}</span>
                <button
                  className={`${s.confirmBtn} ${s.yes}`}
                  onClick={() => handleDelete(item)}
                  disabled={isDeleting}
                >
                  {isDeleting ? '...' : t('common.yes')}
                </button>
                <button
                  className={`${s.confirmBtn} ${s.no}`}
                  onClick={() => setConfirmId(null)}
                  disabled={isDeleting}
                >
                  {t('common.no')}
                </button>
              </div>
            );
          }

          return (
            <div key={itemKey} className={s.docItem}>
              <div className={s.docIcon}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </div>
              <div className={s.docInfo}>
                <span className={s.docName}>{item.name}</span>
                <span className={s.docMeta}>
                  <span>{formatSize(item.size_bytes)}</span>
                  <span>{formatDate(item.created_at, i18n.resolvedLanguage || i18n.language)}</span>
                </span>
              </div>
              <div className={s.docActions}>
                <button
                  className={s.docBtn}
                  onClick={() => handleDownload(item)}
                  title={t('common.download')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                <button
                  className={`${s.docBtn} ${s.danger}`}
                  onClick={() => setConfirmId(itemKey)}
                  title={t('common.delete')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
