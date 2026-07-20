import { useTranslation } from 'react-i18next';
import type { BackupSchedule } from './types';
import styles from './SystemPage.module.css';

export function BackupSchedulePanel({
  schedule,
  saving,
  state,
  onChange,
  onSave,
}: {
  schedule: BackupSchedule;
  saving: boolean;
  state: string;
  onChange: (patch: Partial<BackupSchedule>) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.scheduleGrid}>
      <label>
        <span>{t('system.schedule.frequency')}</span>
        <select
          value={schedule.frequency}
          onChange={(event) =>
            onChange({ frequency: event.target.value as BackupSchedule['frequency'] })
          }
        >
          <option value="off">{t('system.schedule.off')}</option>
          <option value="daily">{t('system.schedule.daily')}</option>
          <option value="weekly">{t('system.schedule.weekly')}</option>
        </select>
      </label>
      <label>
        <span>{t('system.schedule.keepCount')}</span>
        <input
          type="number"
          min="1"
          max="30"
          value={schedule.retention}
          onChange={(event) => onChange({ retention: Number(event.target.value) })}
          disabled={schedule.frequency === 'off'}
        />
      </label>
      <label className={styles.scheduleCheckbox}>
        <input
          type="checkbox"
          checked={schedule.includeUploads}
          onChange={(event) => onChange({ includeUploads: event.target.checked })}
          disabled={schedule.frequency === 'off'}
        />
        <span>
          <strong>{t('system.schedule.includeFiles')}</strong>
          <small>{t('system.schedule.includeFilesHint')}</small>
        </span>
      </label>
      <div className={styles.scheduleAction}>
        <span>
          {state ||
            (schedule.lastRunAt
              ? t('system.schedule.lastRun', { time: new Date(schedule.lastRunAt).toLocaleString() })
              : t('system.schedule.neverRun'))}
        </span>
        <button type="button" className="buttonSecondary" onClick={onSave} disabled={saving}>
          {saving ? t('system.schedule.saving') : t('system.schedule.saveSchedule')}
        </button>
      </div>
    </div>
  );
}
