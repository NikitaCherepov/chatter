import { useTranslation } from 'react-i18next';
import boostyLogo from '../../assets/brand/boosty.svg';
import styles from './AboutSettings.module.scss';

const GITHUB_URL = 'https://github.com/NikitaCherepov/chatter';
const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
const BOOSTY_URL = 'https://boosty.to/hoursen';

export function AboutSettings() {
  const { t } = useTranslation();
  const version = window.electronAPI?.appVersion || '';

  return (
    <div className={styles.about}>
      <div className={styles.identity}>
        <div className={styles.mark}>C</div>
        <div>
          <h2>Chatter</h2>
          <p>{t('settings.about.version', { version })}</p>
        </div>
      </div>

      <div className={styles.details}>
        <p>© 2026 Nikita Cherepov</p>
        <p>{t('settings.about.license')}</p>
      </div>

      <div className={styles.links}>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a href={LICENSE_URL} target="_blank" rel="noreferrer">
          {t('settings.about.licenseLink')}
        </a>
      </div>

      <a
        className={styles.support}
        href={BOOSTY_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={t('settings.about.support')}
      >
        <span>
          <strong>{t('settings.about.support')}</strong>
          <small>{t('settings.about.supportHelp')}</small>
        </span>
        <img src={boostyLogo} alt="Boosty" />
      </a>
    </div>
  );
}
