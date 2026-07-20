'use client';

import type { ReactNode } from 'react';
import styles from './Checkbox.module.css';

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
};

/**
 * Reusable checkbox.
 *
 * Styles mirror desktop-app/src/renderer/components/Checkbox.tsx 1:1 —
 * native <input type="checkbox"> 16x16 with accent-color: var(--accent).
 *
 * The admin panel already has a separate Toggle component (iOS-like switch)
 * for boolean flags inside forms. Checkbox is suited for selection cards,
 * multi-select lists, and anywhere a compact classic checkmark is needed.
 */
export function Checkbox({ checked, onChange, label, disabled }: Props) {
  return (
    <label className={styles.wrap}>
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label != null && label !== false && <span className={styles.label}>{label}</span>}
    </label>
  );
}
