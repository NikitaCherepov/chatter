import { useTranslation } from 'react-i18next';
import styles from './SecretState.module.css';

export function SecretState({ configured }: { configured: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={configured ? styles.configured : styles.missing}>
      {configured ? t('common.saved') : t('common.notSet')}
    </span>
  );
}
