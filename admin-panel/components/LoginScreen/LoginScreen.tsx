import { type FormEvent, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '../../i18n';
import { Select, type SelectOption } from '../ui/Select/Select';
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
  const { t, i18n } = useTranslation();

  const languageOptions = useMemo<SelectOption[]>(() => {
    return SUPPORTED_LANGUAGES.map((code) => ({
      value: code,
      label: LANGUAGE_LABELS[code],
    }));
  }, []);

  const handleLanguageChange = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      document.documentElement.lang = code;
    },
    [i18n],
  );

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
        <p className={styles.subtitle}>{t('login.subtitle')}</p>
        <form className={styles.form} onSubmit={onSubmit}>
          <input
            className={styles.input}
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder={t('login.usernamePlaceholder')}
            aria-label={t('login.usernameLabel')}
            autoComplete="username"
            required
            autoFocus
          />
          <input
            className={styles.input}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            type="password"
            placeholder={t('login.passwordPlaceholder')}
            aria-label={t('login.passwordLabel')}
            autoComplete="current-password"
            required
          />
          {error && <div className={styles.error}>{error}</div>}
          <button className={styles.button} type="submit">
            {t('login.submitButton')}
          </button>
        </form>
        <div className={styles.langRow}>
          <Select
            options={languageOptions}
            value={i18n.language}
            onChange={handleLanguageChange}
            searchable
            maxVisibleItems={3}
            searchPlaceholder={t('ui.search')}
            emptyText={t('ui.nothingFound')}
          />
        </div>
        <div className={styles.divider} />
        <p className={styles.hint}>{t('login.firstTimeHint')}</p>
      </section>
    </main>
  );
}
