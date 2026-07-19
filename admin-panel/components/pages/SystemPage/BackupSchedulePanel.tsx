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
  return (
    <div className={styles.scheduleGrid}>
      <label>
        <span>Периодичность</span>
        <select
          value={schedule.frequency}
          onChange={(event) =>
            onChange({ frequency: event.target.value as BackupSchedule['frequency'] })
          }
        >
          <option value="off">Выключено</option>
          <option value="daily">Ежедневно</option>
          <option value="weekly">Еженедельно</option>
        </select>
      </label>
      <label>
        <span>Хранить последних копий</span>
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
          <strong>Добавлять файлы</strong>
          <small>По умолчанию автобэкап сохраняет только базу</small>
        </span>
      </label>
      <div className={styles.scheduleAction}>
        <span>
          {state ||
            (schedule.lastRunAt
              ? `Последний запуск: ${new Date(schedule.lastRunAt).toLocaleString()}`
              : 'Автобэкапы ещё не запускались')}
        </span>
        <button type="button" className="buttonSecondary" onClick={onSave} disabled={saving}>
          {saving ? 'Сохраняем…' : 'Сохранить расписание'}
        </button>
      </div>
    </div>
  );
}
