import { useTranslation } from 'react-i18next';
import type { SillyTavernBackupPreview, BackupImportProgress } from '../lib/api';
import s from './SillyTavernChatImportDialog.module.scss';
import b from './SillyTavernBackupImportDialog.module.scss';

type Props = {
  preview: SillyTavernBackupPreview;
  importing: boolean;
  progress?: BackupImportProgress | null;
  onCancel: () => void;
  onImport: () => void;
};

export function SillyTavernBackupImportDialog({ preview, importing, progress, onCancel, onImport }: Props) {
  const { t, i18n } = useTranslation();
  const groups = preview.groups;
  const totalChats = preview.chats.count + groups.history_count;
  const importable = preview.characters.count + preview.personas.count + totalChats;
  const formatSize = (bytes: number) => new Intl.NumberFormat(i18n.resolvedLanguage || 'en', {
    style: 'unit', unit: bytes >= 1024 ** 3 ? 'gigabyte' : 'megabyte', unitDisplay: 'short',
    maximumFractionDigits: bytes >= 1024 ** 3 ? 1 : 0,
  }).format(bytes / (bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2));
  const storage = preview.storage;
  const requiredShare = storage ? Math.min(100, Math.max(0, storage.available_bytes > 0 ? storage.required_bytes / storage.available_bytes * 100 : 100)) : 0;
  const infoWarnings = new Set(['group_behavior_changed', 'other_data_ignored']);
  const warnings = [...new Set(preview.warnings)].filter(warning => !infoWarnings.has(warning) && !(warning === 'media_missing' && preview.media.missing > 0));
  const rows = [
    { key: 'characters', label: t('settings.data.backup.summary.characters'), total: preview.characters.count,
      details: [t('settings.data.backup.newCount', { count: preview.characters.create_count }), t('settings.data.backup.existingCount', { count: preview.characters.existing_count })] },
    { key: 'personas', label: t('settings.data.personas.title'), total: preview.personas.count,
      details: [t('settings.data.backup.newCount', { count: preview.personas.create_count }), t('settings.data.backup.updateCount', { count: preview.personas.update_count }), t('settings.data.backup.avatarCount', { count: preview.personas.avatar_count })] },
    { key: 'chats', label: t('settings.data.chats.title'), total: totalChats,
      note: t('settings.data.backup.summary.chatTypes', { personal: preview.chats.count, rooms: groups.history_count }),
      help: groups.history_count > 0 ? t('settings.data.backup.summary.roomsHelp') : undefined,
      details: [t('settings.data.backup.newCount', { count: preview.chats.create_count + groups.create_count }), t('settings.data.backup.existingCount', { count: preview.chats.existing_count + groups.existing_count })] },
    { key: 'media', label: t('settings.data.backup.mediaTitle'), total: preview.media.images + preview.media.files,
      details: [t('settings.data.backup.mediaCount', { images: preview.media.images, files: preview.media.files })] },
  ];
  return (
    <div className={s.overlay} role="presentation" onMouseDown={event => !importing && event.target === event.currentTarget && onCancel()}>
      <div className={[s.dialog, b.dialog].join(' ')} role="dialog" aria-modal="true" aria-labelledby="sillytavern-backup-import-title">
        <div className={s.header}>
          <h3 id="sillytavern-backup-import-title">{t('settings.data.backup.previewTitle')}</h3>
          <span>{t('settings.data.backup.previewHelp')}</span>
        </div>
        <div className={[s.content, b.content].join(' ')}>
          <div className={b.tableWrap}>
            <table className={b.summary} aria-label={t('settings.data.backup.summary.title')}>
              <thead><tr>
                <th scope="col">{t('settings.data.backup.summary.data')}</th>
                <th scope="col" className={b.total}>{t('settings.data.backup.summary.total')}</th>
                <th scope="col">{t('settings.data.backup.summary.details')}</th>
              </tr></thead>
              <tbody>{rows.map(row => (
                <tr key={row.key}>
                  <th scope="row">{row.label}{row.note && <span className={b.rowNote}>{row.note}</span>}{row.help && <span className={b.rowNote}>{row.help}</span>}</th>
                  <td className={b.total}>{row.total}</td>
                  <td className={b.rowDetails}>{row.details.map(detail => <span key={detail}>{detail}</span>)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {storage && (
            <section className={b.storage} aria-labelledby="backup-storage-title">
              <div className={b.storageHeader}>
                <h4 id="backup-storage-title">{t('settings.data.backup.diskSpace')}</h4>
                <span className={storage.sufficient ? b.enough : b.error}>{t(storage.sufficient ? 'settings.data.backup.summary.spaceEnough' : 'settings.data.backup.summary.spaceLow')}</span>
              </div>
              <div className={b.diskLabels}>
                <span>{t('settings.data.backup.summary.required', { size: formatSize(storage.required_bytes) })}</span>
                <span>{t('settings.data.backup.summary.available', { size: formatSize(storage.available_bytes) })}</span>
              </div>
              <div className={b.diskMeter} role="meter" aria-label={t('settings.data.backup.diskSpace')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={requiredShare}
                aria-valuetext={t('settings.data.backup.summary.spaceRatio', { required: formatSize(storage.required_bytes), available: formatSize(storage.available_bytes) })}>
                <div className={storage.sufficient ? b.diskFill : [b.diskFill, b.diskFillError].join(' ')} style={{ width: requiredShare + '%' }} />
              </div>
              <p className={b.hint}>{t('settings.data.backup.summary.diskHint')}</p>
              {!storage.sufficient && <p className={b.error}>{t('settings.data.backup.insufficientSpace')}</p>}
            </section>
          )}
          {(warnings.length > 0 || preview.media.missing > 0 || preview.chat_memory.chat_count > 0) && (
            <ul className={b.warnings} aria-label={t('settings.data.backup.summary.warnings')}>
              {preview.chat_memory.chat_count > 0 && <li>{t('settings.data.backup.summary.memoryWarning', { messages: preview.chat_memory.message_count })}</li>}
              {preview.media.missing > 0 && <li>{t('settings.data.backup.summary.missingMedia', { count: preview.media.missing })}</li>}
              {warnings.map(warning => <li key={warning}>{t('settings.data.backup.warnings.' + warning)}</li>)}
            </ul>
          )}
          <details className={b.notes}>
            <summary>{t('settings.data.backup.summary.more')}</summary>
            <div>
              <p>{t('settings.data.backup.summary.cancelNote')}</p>
              {groups.history_count > 0 && <p>{t('settings.data.backup.summary.groupNote')}</p>}
              {preview.warnings.includes('other_data_ignored') && <p>{t('settings.data.backup.warnings.other_data_ignored')}</p>}
              {preview.chat_memory.chat_count > 0 && <p>{t('settings.data.backup.summary.vectorNote')}</p>}
            </div>
          </details>
        </div>
        <div className={[s.actions, b.actions].join(' ')}>
          {progress && <span className={b.progress} role="status">{t('settings.data.backup.progress.' + progress.stage, { done: progress.done, total: progress.total })}</span>}
          <button className={s.cancel} type="button" onClick={onCancel} disabled={progress?.stage === 'cancelling'}>{t('common.cancel')}</button>
          <button className={s.primary} type="button" onClick={onImport} disabled={importing || importable === 0 || storage?.sufficient === false}>
            {importing ? t('settings.data.backup.importing') : t('settings.data.backup.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
