import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

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
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Chatter</h1>
        <p style={styles.subtitle}>
          {mode === 'login' ? 'Sign in to continue' : 'Create an account'}
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          {mode === 'register' && (
            <input
              style={styles.input}
              type="text"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <input
            style={styles.input}
            type="text"
            placeholder="Login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            autoFocus
          />

          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />

          {error && <div style={styles.error}>{error}</div>}

          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <p style={styles.switchText}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <a href="#" style={styles.link} onClick={(e) => { e.preventDefault(); toggleMode(); }}>
            {mode === 'login' ? 'Sign Up' : 'Sign In'}
          </a>
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    backgroundColor: '#1a1a2e',
    color: '#eee',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: '40px 32px',
    width: 360,
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    textAlign: 'center' as const,
    color: '#e94560',
  },
  subtitle: {
    margin: '8px 0 24px',
    textAlign: 'center' as const,
    color: '#8899aa',
    fontSize: 14,
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  input: {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #2a3a5e',
    backgroundColor: '#0f3460',
    color: '#eee',
    fontSize: 14,
    outline: 'none',
  },
  button: {
    padding: '12px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#e94560',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  switchText: {
    marginTop: 20,
    textAlign: 'center' as const,
    fontSize: 13,
    color: '#8899aa',
  },
  link: {
    color: '#e94560',
    textDecoration: 'none',
    fontWeight: 600,
  },
};
