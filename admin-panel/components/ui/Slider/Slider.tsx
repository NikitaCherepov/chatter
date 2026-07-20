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
  /** Called on slider release / Enter / Space — handy for committing to the API. */
  onCommit?: () => void;
  /** Custom formatting of the value shown on the right. */
  formatValue?: (v: number) => string;
  /** Placeholder text for the null value (e.g. "auto"). */
  nullLabel?: string;
};

type DiscreteSliderProps = CommonProps & {
  mode: 'discrete';
  /** Ordered list of values (null is allowed — typically used as "auto"). */
  values: (string | null)[];
  /** Labels keyed by value. null falls back to nullLabel. */
  labels: Record<string, string>;
  value: string | null;
  onChange: (value: string | null) => void;
  onCommit?: () => void;
  nullLabel?: string;
};

export type SliderProps = NumericSliderProps | DiscreteSliderProps;

/**
 * Reusable slider.
 *
 * Styles mirror desktop-app/src/renderer/components/Slider.tsx 1:1.
 *
 * Two modes:
 *  - `numeric`  —  Label | ═══●═══ value    (e.g. temperature 0..2)
 *  - `discrete` —  Label ═══●═══ value       (e.g. reasoning level: low/medium/high)
 *
 * `onCommit` is called on onMouseUp/onTouchEnd/Enter/Space —
 * convenient for optimistic saves in the admin panel (don't spam the API
 * on every change).
 *
 * In the desktop app `nullLabel` was hardcoded to the i18n key
 * `settings.reasoning.autoLower`. Here the caller passes the localized
 * string via the `nullLabel` prop (default: "авто").
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
