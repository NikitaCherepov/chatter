import { useTranslation } from 'react-i18next';
import type { SillyTavernChatPreview } from '../lib/api';
import s from './SillyTavernChatImportDialog.module.scss';

type Props = {
  previews: SillyTavernChatPreview[];
  importing: boolean;
  onCancel: () => void;
  onImport: () => void;
};

export function SillyTavernChatImportDialog({ previews, importing, onCancel, onImport }: Props) {
  const { t } = useTranslation();
  const totalMessages = previews.reduce((sum, preview) => sum + preview.message_count, 0);
  const newChats = previews.filter(preview => !preview.already_imported_chat_id).length;
  return (
    <div className={s.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && onCancel()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="sillytavern-chat-import-title">
        <div className={s.header}>
          <div>
            <h3 id="sillytavern-chat-import-title">{t('settings.data.chats.previewTitle')}</h3>
            <span>{t('settings.data.chats.previewSummary', { chats: previews.length, messages: totalMessages })}</span>
          </div>
        </div>
        <div className={s.content}>
          {previews.map(preview => (
            <article className={s.chat} key={preview.file_name}>
              <div className={s.chatHeader}>
                <strong>{preview.title}</strong>
                <span className={preview.already_imported_chat_id ? s.existing : s.ready}>
                  {preview.already_imported_chat_id ? t('settings.data.chats.alreadyImported') : t('settings.data.chats.ready')}
                </span>
              </div>
              <div className={s.meta}>
                <span>{t('settings.data.chats.messages', { count: preview.message_count })}</span>
                {preview.character_name && <span>{t('settings.data.chats.character', { name: preview.character_name })}</span>}
                {preview.user_name && <span>{t('settings.data.chats.user', { name: preview.user_name })}</span>}
              </div>
              <div className={s.matches}>
                <span className={preview.matched_prompt_id ? s.matched : s.unmatched}>
                  {preview.matched_prompt_id
                    ? t('settings.data.chats.characterMatched', { name: preview.matched_prompt_name })
                    : t('settings.data.chats.characterNotMatched')}
                </span>
                <span className={preview.matched_persona_id ? s.matched : s.unmatched}>
                  {preview.matched_persona_id
                    ? t('settings.data.chats.personaMatched', { name: preview.matched_persona_name })
                    : t('settings.data.chats.personaNotMatched')}
                </span>
              </div>
              {preview.warnings
                .filter(warning => warning !== 'character_not_matched' && warning !== 'persona_not_matched' && warning !== 'already_imported')
                .map(warning => <p className={s.warning} key={warning}>{t(`settings.data.chats.warnings.${warning}`)}</p>)}
            </article>
          ))}
        </div>
        <div className={s.actions}>
          <button className={s.cancel} onClick={onCancel} disabled={importing}>{t('common.cancel')}</button>
          <button className={s.primary} onClick={onImport} disabled={importing || newChats === 0}>
            {importing ? t('settings.data.chats.importing') : t('settings.data.chats.confirm', { count: newChats })}
          </button>
        </div>
      </div>
    </div>
  );
}
