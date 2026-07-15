import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import s from './Slider.module.scss';

type CommonProps = {
  label: string;
  disabled?: boolean;
};

type NumericSliderProps = CommonProps & {
  mode: 'numeric';
  min: number;
  max: number;
  step: number;
  value: number | null;
  onChange: (value: number | null) => void;
  onCommit?: () => void;
  formatValue?: (v: number) => string;
};

type DiscreteSliderProps = CommonProps & {
  mode: 'discrete';
  values: (string | null)[];
  labels: Record<string, string>;
  value: string | null;
  onChange: (value: string | null) => void;
  onCommit?: () => void;
};

export type SliderProps = NumericSliderProps | DiscreteSliderProps;

export default function Slider(props: SliderProps) {
  const { t } = useTranslation();
  const handleCommit = useCallback(() => {
    props.onCommit?.();
  }, [props]);

  if (props.mode === 'discrete') {
    const { values, labels, value, onChange, label, disabled } = props;
    const idx = Math.max(0, values.indexOf(value));

    return (
      <div className={s.rowCompact}>
        <label className={s.label}>{label}</label>
        <div className={s.slider}>
          <input
            type="range"
            className={s.input}
            min={0}
            max={values.length - 1}
            step={1}
            value={idx}
            disabled={disabled}
            onChange={(e) => {
              const i = Number(e.target.value);
              onChange(values[i] ?? null);
            }}
            onMouseUp={handleCommit}
            onTouchEnd={handleCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleCommit();
            }}
          />
          <span className={s.value}>{labels[String(value)] ?? '—'}</span>
        </div>
      </div>
    );
  }

  // Numeric mode
  const { min, max, step, value, onChange, label, disabled, formatValue } = props;

  return (
    <div className={s.row}>
      <label className={s.label}>{label}</label>
      <div className={s.slider}>
        <input
          type="range"
          className={s.input}
          min={min}
          max={max}
          step={step}
          value={value ?? min}
          disabled={disabled}
          onChange={(e) => {
            onChange(Number(e.target.value));
          }}
          onMouseUp={handleCommit}
          onTouchEnd={handleCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleCommit();
          }}
        />
        <span className={s.value}>
          {value === null ? t('settings.reasoning.autoLower') : (formatValue ? formatValue(value) : String(value))}
        </span>
      </div>
    </div>
  );
}
