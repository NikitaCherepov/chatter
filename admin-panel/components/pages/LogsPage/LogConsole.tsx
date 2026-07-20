import { useTranslation } from 'react-i18next';
import type { Ref } from 'react';
import styles from './LogsPage.module.css';

export function LogConsole({
  lines,
  paused,
  error,
  consoleRef,
}: {
  lines: string[];
  paused: boolean;
  error: string;
  consoleRef: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.console} ref={consoleRef}>
      {lines.length === 0 && <div className={styles.empty}>{error || t('logs.waiting')}</div>}
      {lines.map((line, index) => (
        <div className={styles.line} key={`${index}-${line.slice(0, 40)}`}>
          {line}
        </div>
      ))}
      {paused && <div className={styles.paused}>{t('logs.paused')}</div>}
    </div>
  );
}
