import { useTranslation } from 'react-i18next';
import { Checkbox } from '../../ui/Checkbox/Checkbox';
import { Input } from '../../ui/Input/Input';
import { Select } from '../../ui/Select/Select';
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
        <Select
          value={schedule.frequency}
          onChange={(value) => onChange({ frequency: value as BackupSchedule['frequency'] })}
          options={[
            { value: 'off', label: t('system.schedule.off') },
            { value: 'daily', label: t('system.schedule.daily') },
            { value: 'weekly', label: t('system.schedule.weekly') },
          ]}
        />
      </label>
      <label>
        <span>{t('system.schedule.keepCount')}</span>
        <Input
          type="number"
          min={1}
          max={30}
          value={schedule.retention}
          onChange={(event) => onChange({ retention: Number(event.target.value) })}
          disabled={schedule.frequency === 'off'}
        />
      </label>
      <div className={styles.scheduleCheckbox}>
        <Checkbox
          checked={schedule.includeUploads}
          onChange={(checked) => onChange({ includeUploads: checked })}
          disabled={schedule.frequency === 'off'}
          label={(
            <span className={styles.scheduleCopy}>
              <strong>{t('system.schedule.includeFiles')}</strong>
              <small>{t('system.schedule.includeFilesHint')}</small>
            </span>
          )}
        />
      </div>
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
