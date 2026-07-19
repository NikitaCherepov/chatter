import type { ReactNode } from 'react';
import styles from './FormField.module.css';

export function FormField({ label, hint, state, children }: { label: string; hint?: string; state?: ReactNode; children: ReactNode }) {
  return <label className={styles.field}><span className={styles.label}>{label}{state}</span>{children}{hint && <span className={styles.hint}>{hint}</span>}</label>;
}
