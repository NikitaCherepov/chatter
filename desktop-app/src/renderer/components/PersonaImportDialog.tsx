import { useTranslation } from 'react-i18next';
import type { PersonaImportPreview } from '../lib/api';
import s from './CharacterCardImportDialog.module.scss';

type Props = {
  preview: PersonaImportPreview;
  importing: boolean;
  onCancel: () => void;
  onImport: () => void;
};

export function PersonaImportDialog({ preview, importing, onCancel, onImport }: Props) {
  const { t } = useTranslation();
  return (
    <div className={s.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && onCancel()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="persona-import-title">
        <div className={s.header}>
          <div className={s.avatarFallback}>{preview.count}</div>
          <div>
            <h3 id="persona-import-title">{t('settings.account.personas.import.previewTitle')}</h3>
            <strong>{t('settings.account.personas.import.found', { count: preview.count })}</strong>
            <span>{t('settings.account.personas.import.sourceLabel')}</span>
          </div>
        </div>
        <div className={s.content}>
          <div className={s.summary}>
            <span>{t('settings.account.personas.import.newCount', { count: preview.create_count })}</span>
            <span>{t('settings.account.personas.import.updateCount', { count: preview.update_count })}</span>
            {preview.default_name && <span>{t('settings.account.personas.import.defaultPersona', { name: preview.default_name })}</span>}
          </div>
          <div className={s.sections}>
            {preview.entries.slice(0, 12).map(entry => (
              <div className={s.section} key={entry.key}>
                <span>{entry.exists ? t('settings.account.personas.import.willUpdate') : t('settings.account.personas.import.willCreate')}</span>
                <p>{entry.name}{entry.description ? ` — ${entry.description}` : ''}</p>
              </div>
            ))}
          </div>
          {preview.entries.length > 12 && <p className={s.note}>{t('settings.account.personas.import.more', { count: preview.entries.length - 12 })}</p>}
          {preview.warnings.map(warning => <p className={s.note} key={warning}>{t(`settings.account.personas.import.warnings.${warning}`)}</p>)}
        </div>
        <div className={s.actions}>
          <button className={s.cancel} onClick={onCancel} disabled={importing}>{t('common.cancel')}</button>
          <button className={s.primary} onClick={onImport} disabled={importing}>
            {importing ? t('settings.account.personas.import.importing') : t('settings.account.personas.import.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
