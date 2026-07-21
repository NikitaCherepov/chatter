import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';
import { clearServerConnection, configureServerConnection, loadServerConnection } from '../lib/api';
import s from './AuthPage.module.scss';

export function AuthPage() {
  const { loginAndSet, registerAndSet } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(() => Boolean(loadServerConnection()));
  const [connectionLink, setConnectionLink] = useState('');

  const handleConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await configureServerConnection(connectionLink);
      if (result.reloadRequired) {
        window.location.reload();
        return;
      }
      setConnected(true);
    } catch (err: any) {
      setError(err?.message || t('auth.error.generic'));
    } finally { setLoading(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'login') {
        await loginAndSet(login, password);
      } else {
        await registerAndSet(login, password, name || undefined);
      }
      navigate('/chat', { replace: true });
    } catch (err: any) {
      setError(err?.message || err?.code || t('auth.error.generic'));
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setError('');
  };

  return (
    <div className={s.container}>
      <div className={s.card}>
        <div className={s.logoRow}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="7" fill="var(--accent)" />
            <path d="M8 14L12 18L20 10" stroke="var(--accent-contrast)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h1 className={s.title}>Chatter</h1>
        </div>
        <p className={s.subtitle}>{connected ? (mode === 'login' ? t('auth.subtitle.signIn') : t('auth.subtitle.createAccount')) : t('auth.connection.subtitle')}</p>

        {!connected ? (
          <form onSubmit={handleConnection} className={s.form}>
            <input className={s.input} type="text" placeholder={t('auth.connection.placeholder')} value={connectionLink} onChange={(e) => setConnectionLink(e.target.value)} required autoFocus />
            {error && <div className={s.error}>{error}</div>}
            <button className={s.button} type="submit" disabled={loading}>{loading ? t('common.pleaseWait') : t('auth.connection.connect')}</button>
          </form>
        ) : <>

        <form onSubmit={handleSubmit} className={s.form}>
          {mode === 'register' && (
            <input
              className={s.input}
              type="text"
              placeholder={t('auth.fields.nameOptional')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <input
            className={s.input}
            type="text"
            placeholder={t('auth.fields.login')}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            autoFocus
          />

          <input
            className={s.input}
            type="password"
            placeholder={t('auth.fields.password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />

          {error && <div className={s.error}>{error}</div>}

          <button className={s.button} type="submit" disabled={loading}>
            {loading ? t('common.pleaseWait') : mode === 'login' ? t('auth.actions.signIn') : t('auth.actions.signUp')}
          </button>
        </form>

        <div className={s.divider} />

        <p className={s.switchText}>
          {mode === 'login' ? t('auth.switch.noAccount') : t('auth.switch.hasAccount')}
          <a href="#" className={s.link} onClick={(e) => { e.preventDefault(); toggleMode(); }}>
            {mode === 'login' ? t('auth.actions.signUp') : t('auth.actions.signIn')}
          </a>
        </p>
        <p className={s.switchText}><a href="#" className={s.link} onClick={async (e) => { e.preventDefault(); await clearServerConnection(); window.location.reload(); }}>{t('auth.connection.change')}</a></p>
        </>}
      </div>
    </div>
  );
}
