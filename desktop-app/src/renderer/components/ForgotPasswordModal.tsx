import React, { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import * as api from '../lib/api';
import telegramIcon from '../assets/integrations/telegram.webp';
import s from './ForgotPasswordModal.module.scss';

type Step = 'login' | 'code' | 'newPassword' | 'done';

type Props = {
  onClose: () => void;
};

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
};

const MAX_CODE_ATTEMPTS = 3;

export function ForgotPasswordModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('login');
  const [login, setLogin] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState(MAX_CODE_ATTEMPTS);

  const handleRequestCode = useCallback(async () => {
    const trimmed = login.trim().toLowerCase();
    if (!trimmed) return;
    setLoading(true);
    setError('');
    try {
      await api.apiFetch<{ ok: boolean; method?: string }>('/api/v1/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ login: trimmed }),
      });
      // Server always returns { ok: true } for both valid & invalid logins,
      // to prevent enumeration. If Telegram is not linked, user won't receive
      // a code and will need to use /recover_desktop via the bot instead.
      setStep('code');
      setAttemptsLeft(MAX_CODE_ATTEMPTS);
    } catch (err: any) {
      if (err?.code === 'too_many_requests') {
        setError(t('auth.forgot.rateLimited', { seconds: err?.body?.retry_after || 60 }));
      } else {
        setError(t('auth.forgot.requestFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [login, t]);

  const handleVerifyCode = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed.length !== 6 || !/^\d{6}$/.test(trimmed)) {
      setError(t('auth.forgot.invalidCode'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.apiFetch<{ ok: boolean; reset_token: string }>('/api/v1/auth/verify-reset-code', {
        method: 'POST',
        body: JSON.stringify({ login: login.trim().toLowerCase(), code: trimmed }),
      });
      setResetToken(res.reset_token);
      setStep('newPassword');
    } catch (err: any) {
      if (err?.code === 'wrong_code') {
        const left = err?.body?.attempts_left ?? 0;
        setAttemptsLeft(left);
        if (left <= 0) {
          setError(t('auth.forgot.codeLocked'));
          setStep('login'); // back to start
        } else {
          setError(t('auth.forgot.wrongCode', { attempts: left }));
        }
      } else if (err?.code === 'code_expired') {
        setError(t('auth.forgot.codeExpired'));
        setStep('login');
      } else if (err?.code === 'too_many_attempts') {
        setError(t('auth.forgot.codeLocked'));
        setStep('login');
      } else {
        setError(t('auth.forgot.verifyFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [code, login, t]);

  const handleSetPassword = useCallback(async () => {
    if (newPassword.length < 8) {
      setError(t('auth.forgot.passwordTooShort'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.apiFetch<{ ok: boolean }>('/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ reset_token: resetToken, new_password: newPassword }),
      });
      api.clearTokens();
      setStep('done');
    } catch (err: any) {
      setError(err?.code === 'bad_password_length'
        ? t('auth.forgot.passwordTooShort')
        : t('auth.forgot.resetFailed'));
    } finally {
      setLoading(false);
    }
  }, [newPassword, resetToken, t]);

  const handleKeyDown = (e: React.KeyboardEvent, handler: () => void) => {
    if (e.key === 'Enter') { e.preventDefault(); handler(); }
  };

  const resetToStart = () => {
    setStep('login');
    setError('');
    setCode('');
    setNewPassword('');
  };

  return (
    <motion.div
      className={s.overlay}
      onClick={onClose}
      variants={overlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        variants={modalVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <button className={s.closeBtn} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <h2 className={s.title}>{t('auth.forgot.title')}</h2>

        {step === 'login' && (
          <>
            <p className={s.subtitle}>{t('auth.forgot.subtitle')}</p>

            <div className={s.helpBlock}>
              <img className={s.telegramIcon} src={telegramIcon} alt="" />
              <strong>{t('auth.forgot.helpTitle')}</strong>
              {t('auth.forgot.helpText')}
            </div>

            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('auth.fields.login')}</label>
              <input
                className={s.fieldInput}
                type="text"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleRequestCode)}
                placeholder={t('auth.fields.login')}
                autoFocus
              />
            </div>

            {error && <div className={s.error}>{error}</div>}

            <button
              className={s.button}
              onClick={handleRequestCode}
              disabled={loading || !login.trim()}
            >
              {loading ? t('common.pleaseWait') : t('auth.forgot.sendCode')}
            </button>

            <span className={s.backLink} onClick={onClose}>
              {t('common.back')}
            </span>
          </>
        )}

        {step === 'code' && (
          <>
            <p className={s.subtitle}>{t('auth.forgot.enterCode', { login: login.trim().toLowerCase() })}</p>

            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('auth.forgot.codeLabel')}</label>
              <input
                className={s.codeInput}
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => handleKeyDown(e, handleVerifyCode)}
                placeholder="000000"
                autoFocus
              />
              <div className={`${s.attemptsLeft} ${attemptsLeft <= 1 ? s.danger : ''}`}>
                {t('auth.forgot.attemptsLeft', { count: attemptsLeft })}
              </div>
            </div>

            {error && <div className={s.error}>{error}</div>}

            <button
              className={s.button}
              onClick={handleVerifyCode}
              disabled={loading || code.length !== 6}
            >
              {loading ? t('common.pleaseWait') : t('auth.forgot.verify')}
            </button>

            <span className={s.backLink} onClick={resetToStart}>
              {t('common.back')}
            </span>
          </>
        )}

        {step === 'newPassword' && (
          <>
            <p className={s.subtitle}>{t('auth.forgot.newPasswordTitle')}</p>

            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>{t('auth.fields.password')}</label>
              <input
                className={s.fieldInput}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleSetPassword)}
                placeholder={t('auth.forgot.newPasswordPlaceholder')}
                minLength={8}
                autoFocus
              />
            </div>

            {error && <div className={s.error}>{error}</div>}

            <button
              className={s.button}
              onClick={handleSetPassword}
              disabled={loading || newPassword.length < 8}
            >
              {loading ? t('common.pleaseWait') : t('common.save')}
            </button>

            <span className={s.backLink} onClick={resetToStart}>
              {t('common.back')}
            </span>
          </>
        )}

        {step === 'done' && (
          <>
            <div className={s.success}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <p style={{ marginTop: 12, fontSize: 15, fontWeight: 500 }}>{t('auth.forgot.passwordChanged')}</p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{t('auth.forgot.loginWithNew')}</p>
            </div>
            <button className={s.button} onClick={onClose} style={{ marginTop: 20 }}>
              {t('auth.actions.signIn')}
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
