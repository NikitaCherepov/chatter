import { useTranslation } from 'react-i18next';
import styles from './ActionBar.module.css';

export function ActionBar({
  saving,
  state,
  actionLabel,
  savingLabel,
  disabled = false,
}: {
  saving: boolean;
  state: string;
  actionLabel?: string;
  savingLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isError = state.startsWith(t('common.error'));
  return (
    <div className={styles.bar}>
      <p className={isError ? styles.error : ''}>{state}</p>
      <button type="submit" disabled={saving || disabled}>
        {saving ? (savingLabel || t('common.saving')) : (actionLabel || t('common.saveAndApply'))}
      </button>
    </div>
  );
}
