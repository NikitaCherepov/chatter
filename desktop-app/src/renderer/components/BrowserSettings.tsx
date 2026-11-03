import { useEffect, useState, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { Icon } from './Icon';
import s from './SettingsModal.module.scss';
import rows from './RestrictionsSettings.module.scss';
import toggle from './MemoryPopover.module.scss';
import styles from './BrowserSettings.module.scss';

type BrowserConfirmationKey =
  | 'browser_confirm_open'
  | 'browser_confirm_click'
  | 'browser_confirm_fill';

type BrowserConfirmationSettings = Record<BrowserConfirmationKey, boolean>;

const DEFAULT_SETTINGS: BrowserConfirmationSettings = {
  browser_confirm_open: true,
  browser_confirm_click: true,
  browser_confirm_fill: true,
};

const normalizeSettings = (settings: api.UiSettings): BrowserConfirmationSettings => ({
  browser_confirm_open: settings.browser_confirm_open !== false,
  browser_confirm_click: settings.browser_confirm_click !== false,
  browser_confirm_fill: settings.browser_confirm_fill !== false,
});

export function BrowserSettings({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<BrowserConfirmationKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getUiSettings()
      .then(({ settings: loaded }) => {
        if (!cancelled) setSettings(normalizeSettings(loaded));
      })
      .catch(() => {
        if (!cancelled) toast.error(t('settings.toasts.saveSettingFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [t]);

  const handleChange = async (key: BrowserConfirmationKey, checked: boolean) => {
    const previous = settings;
    setSettings(current => ({ ...current, [key]: checked }));
    setSavingKey(key);
    try {
      const response = await api.setUiSettings({ [key]: checked });
      setSettings(normalizeSettings(response.settings));
    } catch {
      setSettings(previous);
      toast.error(t('settings.toasts.saveSettingFailed'));
    } finally {
      setSavingKey(null);
    }
  };

  const options: Array<{
    key: BrowserConfirmationKey;
    icon: string;
    label: string;
    help: string;
  }> = [
    {
      key: 'browser_confirm_open',
      icon: 'globe',
      label: t('settings.browser.open'),
      help: t('settings.browser.openHelp'),
    },
    {
      key: 'browser_confirm_click',
      icon: 'pointer',
      label: t('settings.browser.click'),
      help: t('settings.browser.clickHelp'),
    },
    {
      key: 'browser_confirm_fill',
      icon: 'text',
      label: t('settings.browser.fill'),
      help: t('settings.browser.fillHelp'),
    },
  ];

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('settings.sections.browser')}</div>
      <p className={rows.intro}>{t('settings.browser.help')}</p>

      {loading ? (
        <div role="status" className={s.promptLoading}>{t('common.loading')}</div>
      ) : (
        <>
          <section className={rows.group} aria-labelledby={`${id}-confirmations`}>
            <h3 id={`${id}-confirmations`}>{t('settings.browser.confirmationsTitle')}</h3>
            {options.map(option => {
              const labelId = `${id}-${option.key}`;
              return <div className={rows.row} key={option.key}>
                <span className={rows.icon}><Icon name={option.icon} size={18} /></span>
                <div className={rows.text}>
                  <span className={rows.label} id={labelId}>{option.label}</span>
                  <p id={`${labelId}-hint`}>{option.help}</p>
                </div>
                <button type="button" role="switch" aria-checked={!settings[option.key]}
                  aria-labelledby={labelId} aria-describedby={`${labelId}-hint`}
                  disabled={savingKey !== null}
                  onClick={() => void handleChange(option.key, !settings[option.key])}
                  className={`${toggle.toggle} ${!settings[option.key] ? toggle.toggleActive : ''}`}><span /></button>
              </div>;
            })}
          </section>
          <div className={styles.notice}>
            <Icon name="lock" size={16} /><span>{t('settings.browser.sensitiveFieldsNote')}</span>
          </div>
        </>
      )}
      {children}
    </div>
  );
}
