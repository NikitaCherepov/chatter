import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '../lib/api';
import s from './QuotaWidget.module.scss';

// function formatTokens(value: number): string {
//   if (!value || value <= 0) return '0';
//   if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
//   if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
//   return String(Math.round(value));
// }

// function formatCost(usd: number): string {
//   if (!usd || usd <= 0) return '$0';
//   if (usd < 0.01) return `$${usd.toFixed(4)}`;
//   return `$${usd.toFixed(2)}`;
// }

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/** SVG donut ring — uses desktop accent colors only. */
function Donut({ percent, size, stroke: strokeProp }: { percent: number; size: number; stroke?: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const stroke = strokeProp ?? (size >= 80 ? 8 : 3);
  const radius = (size - stroke) / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={s.donutSvg}>
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="var(--border-light)" strokeWidth={stroke}
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="var(--accent-icon)" strokeWidth={stroke}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.4s ease' }}
      />
    </svg>
  );
}

type Props = {
  /** 'full' = detailed card for Account settings; 'compact' = small indicator for toolbar */
  variant?: 'full' | 'compact';
  className?: string;
};

export function QuotaWidget({ variant = 'full', className }: Props) {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<api.QuotaInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const info = await api.fetchQuota();
      setQuota(info);
    } catch {
      /* silent — quota is informational */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!quota) return null;

  const percent = quota.percent;
  const isBudget = quota.billing_mode === 'budget';
  const activeQuota = isBudget ? quota.cost.quota : quota.tokens.quota;

  const monthly = quota.quota;
  const monthlyRows = monthly
    ? [
        { key: 'webSearch', entry: monthly.web_search },
        { key: 'webReader', entry: monthly.web_reader },
        { key: 'imageGen', entry: monthly.image_gen },
      ]
    : [];
  // Keep the section (and the future purchase action) visible even when the
  // current plan grants zero external-service usage.
  const hasMonthly = Boolean(monthly);

  // If no active quota and no monthly limits, nothing to show
  if (activeQuota <= 0 && !hasMonthly) return null;

  // const usedLabel = isBudget
  //   ? `${formatCost(quota.cost.used)} / ${formatCost(quota.cost.quota)}`
  //   : `${formatTokens(quota.tokens.used)} / ${formatTokens(quota.tokens.quota)}`;

  // ── Compact: small circle with percentage for the chat toolbar ──
  if (variant === 'compact') {
    if (activeQuota <= 0) return null;
    return (
      <div
        className={`${s.compact} ${className || ''}`}
        title={`${percent}%`}
      >
        <Donut percent={percent} size={30} stroke={2} />
        <span className={s.compactLabel}>{percent}</span>
      </div>
    );
  }

  // ── Full: detailed card for Account settings — donut + monthly limits ──
  return (
    <div className={`${s.full} ${className || ''}`}>
      {activeQuota > 0 && (
        <>
          <div className={s.donutBlock}>
            <div className={s.donutWrap}>
              <Donut percent={percent} size={96} />
              <span className={s.donutPercent}>{percent}%</span>
            </div>
            {/* <div className={s.donutCaption}>
              <strong>{usedLabel}</strong>
              <small>{isBudget ? t('quota.weeklyCost') : t('quota.tokens')}</small>
            </div> */}
          </div>
          <div className={s.resetInfo}>
            <span className={s.resetLabel}>{t('quota.resetsAt')}</span>
            <span className={s.resetValue}>{formatDate(quota.resets_at)}</span>
          </div>
        </>
      )}

      {hasMonthly && monthly && (
        <div className={s.monthly}>
          <div className={s.monthlyHeader}>
            <span className={s.monthlyTitle}>{t('quota.monthly.title')}</span>
            <span className={s.monthlyResets}>
              {t('quota.resetsAt')} {formatDate(monthly.period.ends_at * 1000)}
            </span>
          </div>

          {monthlyRows.map(row => (
            <div key={row.key} className={s.monthlyRow}>
              <span className={s.monthlyLabel}>{t(`quota.monthly.${row.key}`)}</span>
              <span className={s.monthlyValue}>{row.entry.used} / {row.entry.limit}</span>
              <div className={s.monthlyBar}>
                <div
                  className={s.monthlyBarFill}
                  style={{ width: `${row.entry.limit > 0 ? Math.min(100, Math.round((row.entry.used / row.entry.limit) * 100)) : 0}%` }}
                />
              </div>
            </div>
          ))}

          <div className={s.monthlyNote}>{t('quota.monthly.desktopNote')}</div>

          <div className={s.monthlyActions}>
            <button
              type="button"
              className={s.buyButton}
              disabled
              title={t('quota.monthly.buyHint')}
            >
              {t('quota.monthly.buy')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
