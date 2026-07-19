import type { FormEvent } from 'react';
import styles from './LoginScreen.module.css';

type Props = {
  username: string;
  password: string;
  error: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

export function LoginScreen({
  username,
  password,
  error,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: Props) {
  return (
    <main className={styles.container}>
      <section className={styles.card}>
        <div className={styles.logoRow}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <rect width="28" height="28" rx="7" fill="var(--accent)" />
            <path
              d="M8 14L12 18L20 10"
              stroke="var(--accent-contrast)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <h1 className={styles.title}>Chatter</h1>
        </div>
        <p className={styles.subtitle}>Вход в панель управления</p>
        <form className={styles.form} onSubmit={onSubmit}>
          <input
            className={styles.input}
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder="Логин"
            aria-label="Логин"
            autoComplete="username"
            required
            autoFocus
          />
          <input
            className={styles.input}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            type="password"
            placeholder="Пароль"
            aria-label="Пароль"
            autoComplete="current-password"
            required
          />
          {error && <div className={styles.error}>{error}</div>}
          <button className={styles.button} type="submit">
            Войти
          </button>
        </form>
        <div className={styles.divider} />
        <p className={styles.hint}>Данные для первого входа показал установщик.</p>
      </section>
    </main>
  );
}
