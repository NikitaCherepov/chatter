import { useTranslation } from 'react-i18next';
import { Card } from '../../ui/Card/Card';
import styles from './PlaceholderPage.module.css';

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.wrap}>
      <Card>
        <div className={styles.empty}>
          <span>{t('common.sectionReady')}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </Card>
    </div>
  );
}
