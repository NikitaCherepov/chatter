import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import s from './AuthPage.module.scss';

export function AuthPage() {
  const { loginAndSet, registerAndSet } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      setError(err?.message || err?.code || 'Something went wrong');
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
        <p className={s.subtitle}>
          {mode === 'login' ? 'Sign in to continue' : 'Create an account'}
        </p>

        <form onSubmit={handleSubmit} className={s.form}>
          {mode === 'register' && (
            <input
              className={s.input}
              type="text"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <input
            className={s.input}
            type="text"
            placeholder="Login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            autoFocus
          />

          <input
            className={s.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />

          {error && <div className={s.error}>{error}</div>}

          <button className={s.button} type="submit" disabled={loading}>
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <div className={s.divider} />

        <p className={s.switchText}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <a href="#" className={s.link} onClick={(e) => { e.preventDefault(); toggleMode(); }}>
            {mode === 'login' ? 'Sign Up' : 'Sign In'}
          </a>
        </p>
      </div>
    </div>
  );
}
