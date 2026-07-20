'use client';

import type { ReactNode } from 'react';
import styles from './Slider.module.css';

type CommonProps = {
  label: ReactNode;
  disabled?: boolean;
};

type NumericSliderProps = CommonProps & {
  mode: 'numeric';
  min: number;
  max: number;
  step: number;
  value: number | null;
  onChange: (value: number | null) => void;
  /** Вызывается при отпускании ползунка / Enter / Space — удобно для commit в API. */
  onCommit?: () => void;
  /** Кастомное форматирование значения в правой части. */
  formatValue?: (v: number) => string;
  /** Текст-плейсхолдер для значения null (например, «авто»). */
  nullLabel?: string;
};

type DiscreteSliderProps = CommonProps & {
  mode: 'discrete';
  /** Упорядоченный список значений (null разрешён — обычно как «auto»). */
  values: (string | null)[];
  /** Подписи по значению. null → nullLabel. */
  labels: Record<string, string>;
  value: string | null;
  onChange: (value: string | null) => void;
  onCommit?: () => void;
  nullLabel?: string;
};

export type SliderProps = NumericSliderProps | DiscreteSliderProps;

/**
 * Переиспользуемый слайдер.
 *
 * Стили 1-в-1 с desktop-app/src/renderer/components/Slider.tsx.
 *
 * Два режима:
 *  - `numeric`  —  Label | ═══●═══ value    (например, temperature 0..2)
 *  - `discrete` —  Label ═══●═══ value       (например, reasoning level: low/medium/high)
 *
 * `onCommit` вызывается при onMouseUp/onTouchEnd/Enter/Space —
 * удобно для optimistic-save в админке (не спамить API при каждом изменении).
 *
 * В десктопе `nullLabel` жёстко завязан на i18n-ключ `settings.reasoning.autoLower`.
 * В админке локализацию передаёт caller через пропс `nullLabel` (default: «авто»).
 */
export function Slider(props: SliderProps) {
  if (props.mode === 'discrete') {
    const { values, labels, value, onChange, label, disabled, nullLabel = 'авто', onCommit } = props;
    const idx = Math.max(0, values.indexOf(value));
    const display = value === null ? nullLabel : (labels[String(value)] ?? '—');

    return (
      <div className={styles.rowCompact}>
        <label className={styles.label}>{label}</label>
        <div className={styles.slider}>
          <input
            type="range"
            className={styles.input}
            min={0}
            max={values.length - 1}
            step={1}
            value={idx}
            disabled={disabled}
            onChange={(e) => {
              const i = Number(e.target.value);
              onChange(values[i] ?? null);
            }}
            onMouseUp={onCommit}
            onTouchEnd={onCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onCommit?.();
            }}
          />
          <span className={styles.value}>{display}</span>
        </div>
      </div>
    );
  }

  // Numeric mode
  const { min, max, step, value, onChange, label, disabled, formatValue, nullLabel = 'авто', onCommit } = props;

  return (
    <div className={styles.row}>
      <label className={styles.label}>{label}</label>
      <div className={styles.slider}>
        <input
          type="range"
          className={styles.input}
          min={min}
          max={max}
          step={step}
          value={value ?? min}
          disabled={disabled}
          onChange={(e) => {
            onChange(Number(e.target.value));
          }}
          onMouseUp={onCommit}
          onTouchEnd={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onCommit?.();
          }}
        />
        <span className={styles.value}>
          {value === null ? nullLabel : formatValue ? formatValue(value) : String(value)}
        </span>
      </div>
    </div>
  );
}
