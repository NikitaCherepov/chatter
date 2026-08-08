import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';

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

export function BrowserSettings() {
  const { t } = useTranslation();
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
    label: string;
    help: string;
  }> = [
    {
      key: 'browser_confirm_open',
      label: t('settings.browser.open'),
      help: t('settings.browser.openHelp'),
    },
    {
      key: 'browser_confirm_click',
      label: t('settings.browser.click'),
      help: t('settings.browser.clickHelp'),
    },
    {
      key: 'browser_confirm_fill',
      label: t('settings.browser.fill'),
      help: t('settings.browser.fillHelp'),
    },
  ];

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('settings.sections.browser')}</div>
      <span className={s.fieldLabel} style={{ display: 'block', marginBottom: 16, marginTop: -4 }}>
        {t('settings.browser.help')}
      </span>

      {loading ? (
        <div className={s.promptLoading}>{t('common.loading')}</div>
      ) : (
        <>
          <div className={s.voiceSectionTitle}>{t('settings.browser.confirmationsTitle')}</div>
          {options.map(option => (
            <div className={s.fieldGroup} key={option.key}>
              <label className={s.macroToggleLabel}>
                <input
                  type="checkbox"
                  className={s.macroCheckbox}
                  checked={settings[option.key]}
                  onChange={event => void handleChange(option.key, event.target.checked)}
                  disabled={savingKey !== null}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                    {option.help}
                  </div>
                </div>
              </label>
            </div>
          ))}

          <div className={s.connectionNotice}>{t('settings.browser.sensitiveFieldsNote')}</div>
        </>
      )}
    </div>
  );
}
