import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '../lib/api';
import s from './QuotaWidget.module.scss';

function formatTokens(value: number): string {
  if (!value || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(Math.round(value));
}

function formatCost(usd: number): string {
  if (!usd || usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/** SVG donut ring, reused in both compact and detailed modes. */
function Donut({ percent, size }: { percent: number; size: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const stroke = size >= 80 ? 8 : 5;
  const radius = (size - stroke) / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const color = clamped >= 90
    ? 'var(--color-error)'
    : clamped >= 70
      ? 'var(--color-warning)'
      : 'var(--color-success)';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={s.donutSvg}>
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="var(--border-light)" strokeWidth={stroke}
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth={stroke}
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
  const tokenQuota = quota.tokens.quota;
  const costQuota = quota.cost.quota;

  // If neither quota is set, nothing to show
  if (tokenQuota <= 0 && costQuota <= 0) return null;

  // ── Compact: small circle with percentage for the chat toolbar ──
  if (variant === 'compact') {
    const size = 30;
    const colorClass = percent >= 90 ? s.danger : percent >= 70 ? s.warning : s.ok;
    return (
      <div
        className={`${s.compact} ${colorClass} ${className || ''}`}
        title={
          tokenQuota > 0
            ? `${formatTokens(quota.tokens.used)} / ${formatTokens(tokenQuota)} (${percent}%)`
            : `${formatCost(quota.cost.used)} / ${formatCost(costQuota)} (${percent}%)`
        }
      >
        <Donut percent={percent} size={size} />
        <span className={s.compactLabel}>{percent}</span>
      </div>
    );
  }

  // ── Full: detailed card for Account settings ──
  return (
    <div className={`${s.full} ${className || ''}`}>
      <div className={s.donutsRow}>
        {tokenQuota > 0 && (
          <div className={s.donutBlock}>
            <div className={s.donutWrap}>
              <Donut percent={Math.min(100, Math.round(quota.tokens.used / tokenQuota * 100))} size={96} />
              <span className={s.donutPercent}>
                {Math.min(100, Math.round(quota.tokens.used / tokenQuota * 100))}%
              </span>
            </div>
            <div className={s.donutCaption}>
              <strong>{formatTokens(quota.tokens.used)} / {formatTokens(tokenQuota)}</strong>
              <small>{t('quota.tokens')}</small>
            </div>
          </div>
        )}
        {costQuota > 0 && (
          <div className={s.donutBlock}>
            <div className={s.donutWrap}>
              <Donut percent={Math.min(100, Math.round(quota.cost.used / costQuota * 100))} size={96} />
              <span className={s.donutPercent}>
                {Math.min(100, Math.round(quota.cost.used / costQuota * 100))}%
              </span>
            </div>
            <div className={s.donutCaption}>
              <strong>{formatCost(quota.cost.used)} / {formatCost(costQuota)}</strong>
              <small>{t('quota.weeklyCost')}</small>
            </div>
          </div>
        )}
      </div>
      <div className={s.resetInfo}>
        <span className={s.resetLabel}>{t('quota.resetsAt')}</span>
        <span className={s.resetValue}>{formatDate(quota.resets_at)}</span>
      </div>
      {isBudget && (
        <div className={s.billingModeBadge}>{t('quota.budgetMode')}</div>
      )}
    </div>
  );
}
