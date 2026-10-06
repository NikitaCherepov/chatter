import { useTranslation } from 'react-i18next';
import type { SillyTavernBackupPreview, BackupImportProgress } from '../lib/api';
import s from './SillyTavernChatImportDialog.module.scss';

type Props = {
  preview: SillyTavernBackupPreview;
  importing: boolean;
  progress?: BackupImportProgress | null;
  onCancel: () => void;
  onImport: () => void;
};

export function SillyTavernBackupImportDialog({ preview, importing, progress, onCancel, onImport }: Props) {
  const { t } = useTranslation();
  const importable = preview.characters.count + preview.personas.count + preview.chats.count;
  return (
    <div className={s.overlay} role="presentation" onMouseDown={event => !importing && event.target === event.currentTarget && onCancel()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="sillytavern-backup-import-title">
        <div className={s.header}>
          <div>
            <h3 id="sillytavern-backup-import-title">{t('settings.data.backup.previewTitle')}</h3>
            <span>{t('settings.data.backup.previewHelp')}</span>
          </div>
        </div>
        <div className={s.content}>
          {preview.storage && (
            <article className={s.chat}>
              <strong>{t('settings.data.backup.diskSpace')}</strong>
              <p>{t('settings.data.backup.diskEstimate', { available: (preview.storage.available_bytes / 1024 / 1024).toFixed(0), required: (preview.storage.required_bytes / 1024 / 1024).toFixed(0) })}</p>
              <span>{t('settings.data.backup.diskHelp')}</span>
              {!preview.storage.sufficient && <p className={s.warning}>{t('settings.data.backup.insufficientSpace')}</p>}
            </article>
          )}
          <article className={s.chat}>
            <strong>{t('settings.data.backup.mediaTitle')}</strong>
            <p>{t('settings.data.backup.mediaCount', { images: preview.media.images, files: preview.media.files })}</p>
            {preview.media.missing > 0 && <p className={s.warning}>{t('settings.data.backup.mediaMissing', { count: preview.media.missing })}</p>}
          </article>
          <p>{t('settings.data.backup.cancelHelp')}</p>
          {progress && <p role="status">{t('settings.data.backup.progress.' + progress.stage, { done: progress.done, total: progress.total })}</p>}
          <article className={s.chat}>
            <div className={s.chatHeader}>
              <strong>{t('settings.data.character.title')}</strong>
              <span className={s.ready}>{preview.characters.count}</span>
            </div>
            <div className={s.meta}>
              <span>{t('settings.data.backup.newCount', { count: preview.characters.create_count })}</span>
              <span>{t('settings.data.backup.existingCount', { count: preview.characters.existing_count })}</span>
            </div>
          </article>
          <article className={s.chat}>
            <div className={s.chatHeader}>
              <strong>{t('settings.data.personas.title')}</strong>
              <span className={s.ready}>{preview.personas.count}</span>
            </div>
            <div className={s.meta}>
              <span>{t('settings.data.backup.newCount', { count: preview.personas.create_count })}</span>
              <span>{t('settings.data.backup.updateCount', { count: preview.personas.update_count })}</span>
              <span>{t('settings.data.backup.avatarCount', { count: preview.personas.avatar_count })}</span>
            </div>
          </article>
          <article className={s.chat}>
            <div className={s.chatHeader}>
              <strong>{t('settings.data.chats.title')}</strong>
              <span className={s.ready}>{preview.chats.count}</span>
            </div>
            <div className={s.meta}>
              <span>{t('settings.data.backup.newCount', { count: preview.chats.create_count })}</span>
              <span>{t('settings.data.backup.existingCount', { count: preview.chats.existing_count })}</span>
              <span>{t('settings.data.chats.messages', { count: preview.chats.message_count })}</span>
            </div>
          </article>
          {preview.chat_memory.chat_count > 0 && (
            <p className={s.warning}>
              {t('settings.data.backup.chatVectorsWarning', {
                chats: preview.chat_memory.chat_count,
                messages: preview.chat_memory.message_count,
              })}
            </p>
          )}
          {preview.warnings.map(warning => (
            <p className={s.warning} key={warning}>{t(`settings.data.backup.warnings.${warning}`)}</p>
          ))}
        </div>
        <div className={s.actions}>
          <button className={s.cancel} type="button" onClick={onCancel} disabled={progress?.stage === 'cancelling'}>{t('common.cancel')}</button>
          <button className={s.primary} type="button" onClick={onImport} disabled={importing || importable === 0 || preview.storage?.sufficient === false}>
            {importing ? t('settings.data.backup.importing') : t('settings.data.backup.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
