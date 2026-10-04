import { useTranslation } from 'react-i18next';
import type { SillyTavernBackupPreview } from '../lib/api';
import s from './SillyTavernChatImportDialog.module.scss';

type Props = {
  preview: SillyTavernBackupPreview;
  importing: boolean;
  onCancel: () => void;
  onImport: () => void;
};

export function SillyTavernBackupImportDialog({ preview, importing, onCancel, onImport }: Props) {
  const { t } = useTranslation();
  const importable = preview.characters.count + preview.personas.count + preview.chats.count;
  return (
    <div className={s.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && onCancel()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="sillytavern-backup-import-title">
        <div className={s.header}>
          <div>
            <h3 id="sillytavern-backup-import-title">{t('settings.data.backup.previewTitle')}</h3>
            <span>{t('settings.data.backup.previewHelp')}</span>
          </div>
        </div>
        <div className={s.content}>
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
          <button className={s.cancel} type="button" onClick={onCancel} disabled={importing}>{t('common.cancel')}</button>
          <button className={s.primary} type="button" onClick={onImport} disabled={importing || importable === 0}>
            {importing ? t('settings.data.backup.importing') : t('settings.data.backup.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
