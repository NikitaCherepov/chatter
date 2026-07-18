import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import type { MailAccountsResponse, MailProvider } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';

const EMPTY_MAIL_SETTINGS: MailAccountsResponse = { accounts: [], active_account_id: null };

export function MailSettings() {
  const { t } = useTranslation();
  const [data, setData] = useState<MailAccountsResponse>(EMPTY_MAIL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState<MailProvider>('google');
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [login, setLogin] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      setData(await api.getMailAccounts());
    } catch {
      toast.error(t('advanced.mail.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  const resetForm = () => {
    setLabel('');
    setEmail('');
    setLogin('');
    setAppPassword('');
    setImapHost('');
    setImapPort(993);
    setImapSecure(true);
    setSmtpHost('');
    setSmtpPort(465);
    setSmtpSecure(true);
    setShowGuide(false);
  };

  const handleSetup = async () => {
    if (!email.trim()) return toast.error(t('advanced.mail.enterEmail'));
    if (!appPassword.trim()) return toast.error(t('advanced.mail.enterAppPassword'));
    if (provider === 'custom' && (!imapHost.trim() || !smtpHost.trim())) {
      return toast.error(t('advanced.mail.enterServers'));
    }

    setSaving(true);
    try {
      setData(await api.setupMailAccount({
        provider,
        label: label.trim() || undefined,
        email: email.trim(),
        app_password: appPassword,
        ...(provider === 'custom' ? {
          login: login.trim() || email.trim(),
          imap_host: imapHost.trim(),
          imap_port: imapPort,
          imap_secure: imapSecure,
          smtp_host: smtpHost.trim(),
          smtp_port: smtpPort,
          smtp_secure: smtpSecure,
        } : {}),
      }));
      resetForm();
      setShowForm(false);
      toast.success(t('advanced.mail.connected'));
    } catch (error) {
      const code = error instanceof api.ApiError ? error.code : '';
      if (['mail_auth_failed', 'mail_smtp_auth_failed'].includes(code)) toast.error(t('advanced.mail.authFailed'));
      else if (['mail_connection_failed', 'mail_smtp_connection_failed'].includes(code)) toast.error(t('advanced.mail.connectionFailed'));
      else if (code === 'private_mail_host_forbidden') toast.error(t('advanced.mail.privateHostForbidden'));
      else if (code === 'bad_mail_host') toast.error(t('advanced.mail.invalidHost'));
      else if (code === 'mail_runtime_unavailable') toast.error(t('advanced.mail.runtimeUnavailable'));
      else if (code === 'bad_email') toast.error(t('advanced.mail.invalidEmail'));
      else toast.error(t('advanced.mail.setupFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (accountId: number) => {
    setActivating(accountId);
    try {
      setData(await api.activateMailAccount(accountId));
      toast.success(t('advanced.mail.activeChanged'));
    } catch {
      toast.error(t('advanced.mail.activeChangeFailed'));
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async () => {
    const accountId = deleteId;
    setDeleteId(null);
    if (!accountId) return;
    try {
      setData(await api.deleteMailAccount(accountId));
      toast.success(t('advanced.mail.deleted'));
    } catch {
      toast.error(t('advanced.mail.deleteFailed'));
    }
  };

  if (loading) {
    return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;
  }

  const deletedAccount = data.accounts.find(account => account.id === deleteId);

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('advanced.mail.title')}</div>
      <div className={s.fieldLabel} style={{ marginTop: -6, marginBottom: 12, lineHeight: 1.5 }}>
        {t('advanced.mail.description')}
      </div>

      <div className={s.fieldGroup} style={{ gap: 8 }}>
        <label className={s.fieldLabel}>{t('advanced.mail.connectedAccounts')}</label>
        {data.accounts.length === 0 ? (
          <div className={s.macroCard} style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {t('advanced.mail.noAccounts')}
          </div>
        ) : data.accounts.map(account => (
          <div className={s.macroCard} key={account.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontWeight: 600, fontSize: 13 }}>
                  {account.label || account.email}
                  {account.is_active && (
                    <span style={{ color: 'var(--accent-icon)', background: 'rgba(26, 115, 232, 0.08)', borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>
                      {t('advanced.mail.active')}
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t(`advanced.mail.providers.${account.provider}`)} · {account.email}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {!account.is_active && (
                  <button className={s.cancelBtn} disabled={activating !== null} onClick={() => void handleActivate(account.id)}>
                    {activating === account.id ? t('common.pleaseWait') : t('advanced.mail.makeActive')}
                  </button>
                )}
                <button className={s.cancelBtn} style={{ color: '#e74c3c' }} onClick={() => setDeleteId(account.id)}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          </div>
        ))}
        <div className={s.fieldLabel} style={{ lineHeight: 1.5 }}>{t('advanced.mail.activeHelp')}</div>
        <button className={showForm ? s.cancelBtn : s.saveBtn} style={{ alignSelf: 'flex-start' }} onClick={() => setShowForm(value => !value)}>
          {showForm ? t('common.cancel') : t('advanced.mail.addAccount')}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {showForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden', flexShrink: 0 }}
          >
            <div className={s.macroFormDivider} />

            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('advanced.mail.provider')}</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['google', 'yandex', 'custom'] as MailProvider[]).map(item => (
                  <button key={item} className={item === provider ? s.saveBtn : s.cancelBtn} onClick={() => { setProvider(item); setShowGuide(false); }}>
                    {t(`advanced.mail.providers.${item}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('advanced.mail.label')}</label>
              <input className={s.fieldInput} value={label} onChange={event => setLabel(event.target.value)} placeholder={t('advanced.mail.labelPlaceholder')} />
            </div>

            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('advanced.mail.email')}</label>
              <input className={s.fieldInput} type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder={provider === 'google' ? 'name@gmail.com' : provider === 'yandex' ? 'name@yandex.com' : 'name@example.com'} autoComplete="username" />
            </div>

            {provider === 'custom' && (
              <>
                <div className={s.fieldGroup}>
                  <label className={s.fieldLabel}>{t('advanced.mail.login')}</label>
                  <input className={s.fieldInput} value={login} onChange={event => setLogin(event.target.value)} placeholder={t('advanced.mail.loginPlaceholder')} autoComplete="username" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px', gap: 8 }}>
                  <div className={s.fieldGroup}><label className={s.fieldLabel}>{t('advanced.mail.imapHost')}</label><input className={s.fieldInput} value={imapHost} onChange={event => setImapHost(event.target.value)} placeholder="imap.example.com" /></div>
                  <div className={s.fieldGroup}><label className={s.fieldLabel}>{t('advanced.mail.port')}</label><input className={s.fieldInput} type="number" min={1} max={65535} value={imapPort} onChange={event => setImapPort(Number(event.target.value))} /></div>
                </div>
                <label className={s.macroToggleLabel}><input className={s.macroCheckbox} type="checkbox" checked={imapSecure} onChange={event => setImapSecure(event.target.checked)} /><span className={s.fieldLabel}>{t('advanced.mail.secureConnection')}</span></label>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px', gap: 8, marginTop: 12 }}>
                  <div className={s.fieldGroup}><label className={s.fieldLabel}>{t('advanced.mail.smtpHost')}</label><input className={s.fieldInput} value={smtpHost} onChange={event => setSmtpHost(event.target.value)} placeholder="smtp.example.com" /></div>
                  <div className={s.fieldGroup}><label className={s.fieldLabel}>{t('advanced.mail.port')}</label><input className={s.fieldInput} type="number" min={1} max={65535} value={smtpPort} onChange={event => setSmtpPort(Number(event.target.value))} /></div>
                </div>
                <label className={s.macroToggleLabel}><input className={s.macroCheckbox} type="checkbox" checked={smtpSecure} onChange={event => setSmtpSecure(event.target.checked)} /><span className={s.fieldLabel}>{t('advanced.mail.secureConnection')}</span></label>
              </>
            )}

            <div className={s.fieldGroup} style={{ marginTop: 12 }}>
              <label className={s.fieldLabel}>{t('advanced.mail.appPassword')}</label>
              <div className={s.commandRow}>
                <input className={s.fieldInput} type={showPassword ? 'text' : 'password'} value={appPassword} onChange={event => setAppPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !saving) void handleSetup(); }} placeholder={t('advanced.mail.appPasswordPlaceholder')} autoComplete="new-password" />
                <button className={s.macroActionBtn} onClick={() => setShowPassword(value => !value)} title={showPassword ? t('advanced.common.hide') : t('advanced.common.show')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {showPassword ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></> : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
                  </svg>
                </button>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>{t('advanced.mail.passwordSecurity')}</div>
              <button className={s.saveBtn} onClick={() => void handleSetup()} disabled={saving || !email.trim() || !appPassword.trim()}>
                {saving ? t('advanced.mail.checking') : t('advanced.mail.connect')}
              </button>
            </div>

            <div className={s.fieldGroup}>
              <div className={s.macroFormDivider} />
              <button onClick={() => setShowGuide(value => !value)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: showGuide ? 'var(--accent-icon)' : 'var(--text-muted)', fontSize: 13, fontWeight: 500, padding: 0 }}>
                {t('advanced.mail.instructionsTitle', { provider: t(`advanced.mail.providers.${provider}`) })}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showGuide ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              <AnimatePresence initial={false}>
                {showGuide && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden', flexShrink: 0 }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.7, paddingTop: 10 }}>
                    {provider === 'google' ? <ol style={{ margin: 0, paddingLeft: 20 }}><li>{t('advanced.mail.googleGuide.enable2fa')}</li><li><a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a></li><li>{t('advanced.mail.googleGuide.create')}</li><li>{t('advanced.mail.googleGuide.paste')}</li></ol>
                      : provider === 'yandex' ? <ol style={{ margin: 0, paddingLeft: 20 }}><li><a href="https://id.yandex.com/security/app-passwords" target="_blank" rel="noreferrer">id.yandex.com/security/app-passwords</a></li><li>{t('advanced.mail.yandexGuide.create')}</li><li>{t('advanced.mail.yandexGuide.enableImap')}</li><li>{t('advanced.mail.yandexGuide.paste')}</li></ol>
                        : <div>{t('advanced.mail.customGuide')}</div>}
                  </div>
                </motion.div>}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {deleteId && <ConfirmDialog open={true} title={t('advanced.mail.deleteTitle')} text={t('advanced.mail.deleteMessage', { account: deletedAccount?.label || deletedAccount?.email || '' })} onCancel={() => setDeleteId(null)} onConfirm={() => void handleDelete()} />}
    </div>
  );
}
