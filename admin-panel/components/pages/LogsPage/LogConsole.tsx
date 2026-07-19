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
  return (
    <div className={styles.console} ref={consoleRef}>
      {lines.length === 0 && <div className={styles.empty}>{error || 'Ожидаем строки логов…'}</div>}
      {lines.map((line, index) => (
        <div className={styles.line} key={`${index}-${line.slice(0, 40)}`}>
          {line}
        </div>
      ))}
      {paused && <div className={styles.paused}>Вывод приостановлен</div>}
    </div>
  );
}
