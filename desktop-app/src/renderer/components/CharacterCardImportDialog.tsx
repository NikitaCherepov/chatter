import { useTranslation } from 'react-i18next';
import type { CharacterCardPreview } from '../lib/api';
import s from './CharacterCardImportDialog.module.scss';

type Props = {
  preview: CharacterCardPreview;
  imageUrl: string | null;
  importing: boolean;
  onCancel: () => void;
  onImport: () => void;
};

export function CharacterCardImportDialog({ preview, imageUrl, importing, onCancel, onImport }: Props) {
  const { t } = useTranslation();
  const populatedSections = Object.entries(preview.sections).filter(([, value]) => Boolean(value));
  return (
    <div className={s.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && onCancel()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="character-card-import-title">
        <div className={s.header}>
          {(imageUrl || preview.avatar_data_url) ? <img src={imageUrl || preview.avatar_data_url!} alt="" /> : <div className={s.avatarFallback}>{preview.name.slice(0, 1)}</div>}
          <div>
            <h3 id="character-card-import-title">{t('settings.prompt.characterCard.previewTitle')}</h3>
            <strong>{preview.name}</strong>
            <span>{preview.source_format.toUpperCase()} · Character Card {preview.spec.toUpperCase()}</span>
          </div>
        </div>
        <div className={s.content}>
          <div className={s.summary}>
            <span>{t('settings.prompt.characterCard.sectionsFound', { count: populatedSections.length })}</span>
            {preview.first_message_present && <span>{t('settings.prompt.characterCard.firstMessageSaved')}</span>}
            {preview.alternate_greetings_count > 0 && <span>{t('settings.prompt.characterCard.alternateGreetings', { count: preview.alternate_greetings_count })}</span>}
            {preview.has_character_book && <span>{t('settings.prompt.characterCard.lorebookSaved')}</span>}
            {preview.asset_count > 0 && <span>{t('settings.prompt.characterCard.assetsSaved', { count: preview.asset_count })}</span>}
          </div>
          {preview.description && <p className={s.description}>{preview.description}</p>}
          <div className={s.sections}>
            {populatedSections.map(([key, value]) => (
              <div className={s.section} key={key}>
                <span>{t(`settings.prompt.sections.${key}`)}</span>
                <p>{value}</p>
              </div>
            ))}
          </div>
          {preview.warnings.length > 0 && <div className={s.note}>{t('settings.prompt.characterCard.preservedNote')}</div>}
        </div>
        <div className={s.actions}>
          <button type="button" className={s.cancel} onClick={onCancel} disabled={importing}>{t('common.cancel')}</button>
          <button type="button" className={s.primary} onClick={onImport} disabled={importing}>
            {importing ? t('settings.prompt.characterCard.importing') : t('settings.prompt.characterCard.import')}
          </button>
        </div>
      </div>
    </div>
  );
}
