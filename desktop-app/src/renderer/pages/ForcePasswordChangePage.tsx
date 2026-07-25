import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import s from './AuthPage.module.scss';

export function ForcePasswordChangePage() {
  const { t } = useTranslation();
  const { user, setUser, logout } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!currentPassword) {
      setError(t('auth.forgot.passwordTooShort'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('auth.forgot.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('forcePassword.passwordsDoNotMatch'));
      return;
    }
    if (newPassword === currentPassword) {
      setError(t('forcePassword.sameAsOld'));
      return;
    }

    setLoading(true);
    try {
      await api.apiFetch('/api/v1/user/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      // Tokens are revoked by the server after password change — must clear local state.
      api.clearTokens();
      localStorage.removeItem('chatter_user');
      setUser(null);
      toast.success(t('forcePassword.success'));
    } catch (err: any) {
      const code = err?.code || err?.message;
      if (code === 'wrong_current_password') {
        setError(t('settings.toasts.wrongPassword'));
      } else if (code === 'bad_password_length') {
        setError(t('auth.forgot.passwordTooShort'));
      } else {
        setError(t('auth.forgot.resetFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s.container}>
      <form className={s.card} onSubmit={handleSubmit}>
        <h2 className={s.title}>{t('forcePassword.title')}</h2>
        <p className={s.subtitle}>{t('forcePassword.subtitle')}</p>

        <div className={s.form}>
          <input
            className={s.input}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder={t('settings.account.currentPassword')}
            autoFocus
            autoComplete="current-password"
          />
          <input
            className={s.input}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('auth.forgot.newPasswordPlaceholder')}
            minLength={8}
            autoComplete="new-password"
          />
          <input
            className={s.input}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('forcePassword.confirmPlaceholder')}
            minLength={8}
            autoComplete="new-password"
          />

          {error && <div className={s.error}>{error}</div>}

          <button className={s.button} type="submit" disabled={loading || !currentPassword || newPassword.length < 8 || !confirmPassword}>
            {loading ? t('common.pleaseWait') : t('forcePassword.submit')}
          </button>

          <p className={s.switchText}>
            <a href="#" className={s.link} onClick={(e) => { e.preventDefault(); logout(); }}>
              {t('forcePassword.logout')}
            </a>
          </p>
        </div>
      </form>
    </div>
  );
}
