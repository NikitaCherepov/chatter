import { useTranslation } from 'react-i18next';
import styles from './ActionBar.module.css';

export function ActionBar({ saving, state }: { saving: boolean; state: string }) {
  const { t } = useTranslation();
  const isError = state.startsWith(t('common.error'));
  return (
    <div className={styles.bar}>
      <p className={isError ? styles.error : ''}>{state}</p>
      <button type="submit" disabled={saving}>
        {saving ? t('common.saving') : t('common.saveAndApply')}
      </button>
    </div>
  );
}
