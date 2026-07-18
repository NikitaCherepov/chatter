import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import type { MailAccountsResponse, MailProvider } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';

const EMPTY_MAIL_SETTINGS: MailAccountsResponse = {
  accounts: [],
  active_provider: null,
  mail_check_limit: 10,
  max_mail_check_limit: 10,
};

export function MailSettings() {
  const { t } = useTranslation();
  const [data, setData] = useState<MailAccountsResponse>(EMPTY_MAIL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<MailProvider>('google');
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState<MailProvider | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<MailProvider | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [limit, setLimit] = useState(10);
  const [savingLimit, setSavingLimit] = useState(false);

  const applyResponse = (response: MailAccountsResponse) => {
    setData(response);
    setLimit(response.mail_check_limit);
  };

  const loadAccounts = useCallback(async () => {
    try {
      applyResponse(await api.getMailAccounts());
    } catch {
      toast.error(t('advanced.mail.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  const handleSetup = async () => {
    if (!email.trim()) {
      toast.error(t('advanced.mail.enterEmail'));
      return;
    }
    if (!appPassword.trim()) {
      toast.error(t('advanced.mail.enterAppPassword'));
      return;
    }

    setSaving(true);
    try {
      applyResponse(await api.setupMailAccount(provider, email.trim(), appPassword));
      setEmail('');
      setAppPassword('');
      toast.success(t('advanced.mail.connected'));
    } catch (error) {
      const code = error instanceof api.ApiError ? error.code : '';
      if (code === 'mail_auth_failed') toast.error(t('advanced.mail.authFailed'));
      else if (code === 'mail_connection_failed') toast.error(t('advanced.mail.connectionFailed'));
      else if (code === 'mail_runtime_unavailable') toast.error(t('advanced.mail.runtimeUnavailable'));
      else if (code === 'bad_email') toast.error(t('advanced.mail.invalidEmail'));
      else toast.error(t('advanced.mail.setupFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (nextProvider: MailProvider) => {
    setActivating(nextProvider);
    try {
      applyResponse(await api.activateMailAccount(nextProvider));
      toast.success(t('advanced.mail.activeChanged'));
    } catch {
      toast.error(t('advanced.mail.activeChangeFailed'));
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async () => {
    const target = deleteProvider;
    setDeleteProvider(null);
    if (!target) return;
    try {
      applyResponse(await api.deleteMailAccount(target));
      toast.success(t('advanced.mail.deleted'));
    } catch {
      toast.error(t('advanced.mail.deleteFailed'));
    }
  };

  const handleSaveLimit = async () => {
    const safeLimit = Math.max(1, Math.floor(limit));
    setSavingLimit(true);
    try {
      applyResponse(await api.updateMailSettings(safeLimit));
      toast.success(t('advanced.mail.limitSaved'));
    } catch {
      toast.error(t('advanced.mail.limitSaveFailed'));
    } finally {
      setSavingLimit(false);
    }
  };

  if (loading) {
    return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;
  }

  const replacingCurrentProvider = data.accounts.some(account => account.provider === provider);

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('advanced.mail.title')}</div>
      <div className={s.fieldLabel} style={{ marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>
        {t('advanced.mail.description')}
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.mail.connectedAccounts')}</label>
        {data.accounts.length === 0 ? (
          <div className={s.macroCard} style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {t('advanced.mail.noAccounts')}
          </div>
        ) : data.accounts.map(account => (
          <div className={s.macroCard} key={account.provider}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontWeight: 600, fontSize: 13 }}>
                  {t(`advanced.mail.providers.${account.provider}`)}
                  {account.is_active && (
                    <span style={{ color: 'var(--accent-icon)', background: 'rgba(26, 115, 232, 0.08)', borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>
                      {t('advanced.mail.active')}
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {account.email}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {!account.is_active && (
                  <button className={s.cancelBtn} disabled={activating !== null} onClick={() => void handleActivate(account.provider)}>
                    {activating === account.provider ? t('common.pleaseWait') : t('advanced.mail.makeActive')}
                  </button>
                )}
                <button className={s.cancelBtn} style={{ color: '#e74c3c' }} onClick={() => setDeleteProvider(account.provider)}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          </div>
        ))}
        <div className={s.fieldLabel} style={{ lineHeight: 1.5 }}>
          {t('advanced.mail.activeHelp')}
        </div>
      </div>

      <div className={s.macroFormDivider} />

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.mail.provider')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['google', 'yandex'] as MailProvider[]).map(item => (
            <button
              key={item}
              className={item === provider ? s.saveBtn : s.cancelBtn}
              style={{ alignSelf: 'stretch' }}
              onClick={() => { setProvider(item); setShowGuide(false); }}
            >
              {t(`advanced.mail.providers.${item}`)}
            </button>
          ))}
        </div>
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.mail.email')}</label>
        <input
          className={s.fieldInput}
          type="email"
          value={email}
          onChange={event => setEmail(event.target.value)}
          placeholder={provider === 'google' ? 'name@gmail.com' : 'name@yandex.com'}
          autoComplete="username"
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.mail.appPassword')}</label>
        <div className={s.commandRow}>
          <input
            className={s.fieldInput}
            type={showPassword ? 'text' : 'password'}
            value={appPassword}
            onChange={event => setAppPassword(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !saving) void handleSetup(); }}
            placeholder={t('advanced.mail.appPasswordPlaceholder')}
            autoComplete="new-password"
          />
          <button
            className={s.macroActionBtn}
            onClick={() => setShowPassword(value => !value)}
            title={showPassword ? t('advanced.common.hide') : t('advanced.common.show')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showPassword ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </div>
        {replacingCurrentProvider && (
          <div style={{ color: '#d98719', fontSize: 11 }}>{t('advanced.mail.replaceWarning')}</div>
        )}
        <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>
          {t('advanced.mail.passwordSecurity')}
        </div>
        <button className={s.saveBtn} onClick={() => void handleSetup()} disabled={saving || !email.trim() || !appPassword.trim()}>
          {saving ? t('advanced.mail.checking') : t('advanced.mail.connect')}
        </button>
      </div>

      <div className={s.fieldGroup}>
        <div className={s.macroFormDivider} />
        <button
          onClick={() => setShowGuide(value => !value)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: showGuide ? 'var(--accent-icon)' : 'var(--text-muted)', fontSize: 13, fontWeight: 500, padding: 0 }}
        >
          {t('advanced.mail.instructionsTitle', { provider: t(`advanced.mail.providers.${provider}`) })}
          <span style={{ transform: showGuide ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>⌄</span>
        </button>
        <AnimatePresence initial={false}>
          {showGuide && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.7, paddingTop: 10 }}>
                {provider === 'google' ? (
                  <ol style={{ margin: 0, paddingLeft: 20 }}>
                    <li>{t('advanced.mail.googleGuide.enable2fa')}</li>
                    <li><a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a></li>
                    <li>{t('advanced.mail.googleGuide.create')}</li>
                    <li>{t('advanced.mail.googleGuide.paste')}</li>
                  </ol>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 20 }}>
                    <li><a href="https://id.yandex.com/security/app-passwords" target="_blank" rel="noreferrer">id.yandex.com/security/app-passwords</a></li>
                    <li>{t('advanced.mail.yandexGuide.create')}</li>
                    <li>{t('advanced.mail.yandexGuide.enableImap')}</li>
                    <li>{t('advanced.mail.yandexGuide.paste')}</li>
                  </ol>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={s.macroFormDivider} />
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.mail.resultLimit')}</label>
        <div className={s.commandRow}>
          <input
            className={s.fieldInput}
            type="number"
            min={1}
            max={data.max_mail_check_limit || undefined}
            value={limit}
            onChange={event => setLimit(Number(event.target.value))}
          />
          <button className={s.cancelBtn} onClick={() => void handleSaveLimit()} disabled={savingLimit}>
            {savingLimit ? t('common.saving') : t('common.save')}
          </button>
        </div>
        <div className={s.fieldLabel}>{t('advanced.mail.resultLimitHelp', { max: data.max_mail_check_limit || '∞' })}</div>
      </div>

      {deleteProvider && (
        <ConfirmDialog
          open={true}
          title={t('advanced.mail.deleteTitle')}
          text={t('advanced.mail.deleteMessage', { provider: t(`advanced.mail.providers.${deleteProvider}`) })}
          onCancel={() => setDeleteProvider(null)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </div>
  );
}
