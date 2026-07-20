'use client';

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import styles from './RadioGroup.module.css';

export type RadioOption = {
  value: string;
  label: string;
};

type Props = {
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  /** Иконка внутри триггера (по умолчанию — иконка «слоёв»). */
  icon?: ReactNode;
  className?: string;
};

/**
 * Переиспользуемый RadioGroup в виде компактного dropdown-триггера.
 *
 * Стили 1-в-1 с desktop-app/src/renderer/components/RadioGroup.tsx.
 *
 * В десктопе используется на карте (MapTool) — выбор слоя карты.
 * Цветовая схема «карточная» (голубой фон #e8f0fe, синий текст #1a73 e8)
 * — намеренно отличается от формы-стиля, т.к. это «плавающая» кнопка
 * поверх контента (карта, диаграммы и т.д.). Управляется через
 * CSS-переменные --rg-bg / --rg-hover / --rg-accent / --rg-shadow
 * в .root, при желании можно переопределить.
 */
export function RadioGroup({ options, value, onChange, icon, className }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open, handleClickOutside]);

  return (
    <div ref={containerRef} className={`${styles.root} ${className ?? ''}`}>
      <button
        className={`${styles.trigger} ${open ? styles.triggerActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {icon ?? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
            <line x1="8" y1="2" x2="8" y2="18" />
            <line x1="16" y1="6" x2="16" y2="22" />
          </svg>
        )}
      </button>

      {open && (
        <div className={styles.dropdown}>
          {options.map((opt) => (
            <label key={opt.value} className={styles.option}>
              <span className={`${styles.radio} ${opt.value === value ? styles.radioChecked : ''}`}>
                {opt.value === value && <span className={styles.radioDot} />}
              </span>
              <span className={styles.optionLabel}>{opt.label}</span>
              <input
                type="radio"
                className={styles.hiddenInput}
                checked={opt.value === value}
                onChange={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
