'use client';

import { useTranslation } from 'react-i18next';
import type { MetricsRange } from '../../../lib/services/systemService';
import styles from './SystemPage.module.css';

const RANGES: MetricsRange[] = ['24h', '3d', '7d'];

const RANGE_KEY: Record<MetricsRange, string> = {
  '24h': 'system.chart.last24h',
  '3d': 'system.chart.last3days',
  '7d': 'system.chart.last7days',
};

type Props = {
  value: MetricsRange;
  onChange: (range: MetricsRange) => void;
};

export function RangeSelector({ value, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <div className={styles.rangeSelector}>
      {RANGES.map((r) => (
        <button
          key={r}
          className={value === r ? styles.rangeBtnActive : styles.rangeBtn}
          onClick={() => onChange(r)}
        >
          {t(RANGE_KEY[r])}
        </button>
      ))}
    </div>
  );
}
