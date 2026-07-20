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
 * Переиспользуемый чекбокс.
 *
 * Стили 1-в-1 с desktop-app/src/renderer/components/Checkbox.tsx —
 * нативный <input type="checkbox"> 16x16 с accent-color: var(--accent).
 *
 * В админке есть отдельный компонент Toggle (iOS-like switch) для
 * boolean-флагов в формах. Checkbox подходит для карточек выбора,
 * многоселектов и случаев, где нужна компактная классическая галочка.
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
