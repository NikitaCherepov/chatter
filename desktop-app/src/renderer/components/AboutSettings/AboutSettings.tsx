import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import boostyLogo from '../../assets/brand/boosty.svg';
import styles from './AboutSettings.module.scss';

const GITHUB_URL = 'https://github.com/NikitaCherepov';
const LICENSE_URL = `${GITHUB_URL}/chatter/blob/main/LICENSE`;
const BOOSTY_URL = 'https://boosty.to/hoursen';
const WEBSITE_URL = 'https://ncherepov.ru';

export function AboutSettings() {
  const { t } = useTranslation();
  const version = window.electronAPI?.appVersion || '';
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const checkForUpdates = async () => {
    if (!window.electronAPI?.updateCheck || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const result = await window.electronAPI.updateCheck();
      if (result.error) {
        toast.error(t('settings.about.updateCheckFailed'));
      } else if (result.disabled) {
        toast.info(t('settings.about.updateCheckUnavailable'));
      } else if (!result.updateAvailable) {
        toast.success(t('settings.about.upToDate'));
      }
    } catch {
      toast.error(t('settings.about.updateCheckFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div className={styles.about}>
      <div className={styles.identity}>
        <div className={styles.mark}>C</div>
        <div className={styles.identityText}>
          <h2>Chatter</h2>
          <p>{t('settings.about.version', { version })}</p>
        </div>
        <button
          type="button"
          className={styles.checkUpdates}
          disabled={checkingUpdate}
          onClick={() => void checkForUpdates()}
        >
          {checkingUpdate
            ? t('settings.about.checkingUpdates')
            : t('settings.about.checkUpdates')}
        </button>
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
        <a href={WEBSITE_URL} target="_blank" rel="noreferrer">
          {t('settings.about.website')}
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
