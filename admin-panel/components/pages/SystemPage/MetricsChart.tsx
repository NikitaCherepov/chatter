'use client';

import { useTranslation } from 'react-i18next';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { MetricPoint } from '../../../lib/services/systemService';
import styles from './SystemPage.module.css';

type MetricKey = 'cpu' | 'mem' | 'swap' | 'disk';

const METRIC_CONFIG: Record<MetricKey, { color: string; labelKey: string; unit: string }> = {
  cpu: { color: '#122d4d', labelKey: 'system.serverStatus.cpu', unit: '%' },
  mem: { color: '#2563eb', labelKey: 'system.serverStatus.memory', unit: '%' },
  swap: { color: '#ca8a04', labelKey: 'system.serverStatus.swap', unit: '%' },
  disk: { color: '#15803d', labelKey: 'system.serverStatus.disk', unit: '%' },
};

type Props = {
  metric: MetricKey;
  data: MetricPoint[];
  isLoading: boolean;
};

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MetricsChart({ metric, data, isLoading }: Props) {
  const { t } = useTranslation();
  const cfg = METRIC_CONFIG[metric];

  if (isLoading && !data.length) {
    return <div className={styles.chartEmpty}>{t('system.chart.loading')}</div>;
  }

  if (!data.length) {
    return <div className={styles.chartEmpty}>{t('system.chart.noData')}</div>;
  }

  return (
    <div className={styles.chartWrap}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cfg.color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={cfg.color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border-light)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={formatTime}
            tick={{ fontSize: 9, fill: 'var(--text-hint)' }}
            axisLine={false}
            tickLine={false}
            minTickGap={60}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 9, fill: 'var(--text-hint)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}%`}
            width={36}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-light)',
              borderRadius: 7,
              fontSize: 11,
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-card)',
            }}
            labelFormatter={formatTime}
            formatter={(value) => [`${Number(value).toFixed(1)}%`, t(cfg.labelKey)]}
          />
          <Area
            type="monotone"
            dataKey={metric}
            stroke={cfg.color}
            strokeWidth={1.5}
            fill={`url(#grad-${metric})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
