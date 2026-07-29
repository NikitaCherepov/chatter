import { useTranslation } from 'react-i18next';
import { Card } from '../../../ui/Card/Card';
import styles from './AboutPanel.module.css';

const GITHUB_URL = 'https://github.com/NikitaCherepov';
const LICENSE_URL = `${GITHUB_URL}/chatter/blob/main/LICENSE`;

export function AboutPanel() {
  const { t } = useTranslation();

  return (
    <Card title={t('settings.aboutTitle')} description={t('settings.aboutDescription')}>
      <div className={styles.content}>
        <div className={styles.details}>
          <strong>Chatter</strong>
          <span>© 2026 Nikita Cherepov</span>
          <span>{t('settings.aboutLicense')}</span>
          <div className={styles.textLinks}>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
              {t('settings.aboutLicenseLink')}
            </a>
          </div>
        </div>

        <div className={styles.buttons}>
          <a
            className={styles.linkButton}
            href="https://boosty.to/hoursen"
            target="_blank"
            rel="noreferrer"
            aria-label={t('settings.aboutBoosty')}
          >
            <img src="/boosty.svg" alt="Boosty" />
          </a>
          <a
            className={styles.linkButton}
            href="https://ncherepov.ru"
            target="_blank"
            rel="noreferrer"
          >
            {t('settings.aboutWebsite')}
          </a>
        </div>
      </div>
    </Card>
  );
}
