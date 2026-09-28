import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBar } from '../../ui/ActionBar/ActionBar';
import { Icon } from '../../icons/icons';
import styles from './IntegrationsPage.module.css';

export function IntegrationDetailPage({
  title,
  description,
  saving,
  saveState,
  onBack,
  onSave,
  showSave = true,
  children,
}: {
  title: string;
  description: string;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
  showSave?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <form className={styles.detailPage} onSubmit={onSave}>
      <header className={styles.detailHeader}>
        <button className={styles.backButton} type="button" onClick={onBack} aria-label={t('integrations.back')}>
          <Icon name="arrow" />
        </button>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className={styles.detailCard}>{children}</div>
      {showSave && <ActionBar saving={saving} state={saveState} />}
    </form>
  );
}
