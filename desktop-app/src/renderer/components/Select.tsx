import React, { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './Select.module.scss';

/** Ограниченный набор цветов бейджа — каждый берётся из CSS-переменной. */
export type BadgeColor = 'success' | 'error' | 'info' | 'warning';

/** Бейдж для option: если нет icon — рисуется текст в квадратных скобках. */
export type SelectBadge = {
  /** Текст бейджа (для title, а при отсутствии icon — для отображения в [скобках]) */
  text: string;
  /** Цвет. По умолчанию 'success' */
  color?: BadgeColor;
  /** Кастомная иконка. Если не передана — рисуется [text] */
  icon?: ReactNode;
};

/** Optional model meta shown as a compact row under the hint. */
export type SelectOptionMeta = {
  /** Intelligence level 1..3 — rendered as filled squares scale. */
  intel?: 1 | 2 | 3;
  /** Measured generation speed (tokens/sec) — rendered as an exact number. */
  speedTps?: number;
  /** Speed level 1..3 — rendered as squares (used when token display is off). */
  speed?: 1 | 2 | 3;
  /** Price tier 1..3 — rendered as $ / $$ / $$$. */
  price?: 1 | 2 | 3;
};

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  badge?: SelectBadge;
  meta?: SelectOptionMeta;
};

type Props = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  maxVisibleItems?: number;
};

export function Select({
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  searchable = false,
  maxVisibleItems = 8,
}: Props) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t('common.selectPlaceholder');
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = search.toLowerCase().trim();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false)
    );
  }, [search, options, searchable]);

  const selectedOption = useMemo(() => {
    return options.find((o) => o.value === value) ?? null;
  }, [value, options]);

  const selectedLabel = selectedOption ? selectedOption.label : resolvedPlaceholder;

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Focus search on open
  useEffect(() => {
    if (isOpen && searchable) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [isOpen, searchable]);

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setSearch('');
  };

  const renderBadge = (badge: SelectBadge) => {
    const colorVar = badge.color ? `var(--color-${badge.color})` : 'var(--color-success)';
    return (
      <span
        className={s.badge}
        style={{ color: colorVar }}
        title={badge.text}
      >
        {badge.icon ?? `[${badge.text}]`}
      </span>
    );
  };

  const INTEL_LABELS = ['chat.model.meta.intel.low', 'chat.model.meta.intel.mid', 'chat.model.meta.intel.high'];
  const SPEED_LABELS = ['chat.model.meta.speed.low', 'chat.model.meta.speed.mid', 'chat.model.meta.speed.high'];
  const PRICE_LABELS = ['chat.model.meta.price.low', 'chat.model.meta.price.mid', 'chat.model.meta.price.high'];

  const renderIntel = (level: 1 | 2 | 3) => (
    <span className={s.metaItem} title={t('chat.model.meta.intel.label') + ': ' + t(INTEL_LABELS[level - 1])}>
      <span className={s.metaLabel}>{t('chat.model.meta.intel.label')}</span>
      <span className={s.metaScale}>
        {[1, 2, 3].map(i => (
          <span key={i} className={`${s.metaSquare} ${i <= level ? s.metaSquareFilled : ''}`} />
        ))}
      </span>
    </span>
  );

  // Exact number — shown when token display is enabled.
  const renderSpeedTps = (tps: number) => (
    <span className={s.metaItem} title={t('chat.model.meta.speed.label') + ': ~' + Math.round(tps) + ' t/s'}>
      <span className={s.metaLabel}>{t('chat.model.meta.speed.label')}</span>
      <span className={s.metaValue}>{Math.round(tps)} t/s</span>
    </span>
  );

  // Discrete scale — shown when token display is disabled (no exact numbers).
  const renderSpeedScale = (level: 1 | 2 | 3) => (
    <span className={s.metaItem} title={t('chat.model.meta.speed.label') + ': ' + t(SPEED_LABELS[level - 1])}>
      <span className={s.metaLabel}>{t('chat.model.meta.speed.label')}</span>
      <span className={s.metaScale}>
        {[1, 2, 3].map(i => (
          <span key={i} className={`${s.metaSquare} ${i <= level ? s.metaSquareFilled : ''}`} />
        ))}
      </span>
    </span>
  );

  const renderPrice = (tier: 1 | 2 | 3) => (
    <span className={s.metaItem} title={t('chat.model.meta.price.label') + ': ' + t(PRICE_LABELS[tier - 1])}>
      <span className={s.metaLabel}>{t('chat.model.meta.price.label')}</span>
      <span className={s.metaDollars}>{'$'.repeat(tier)}</span>
    </span>
  );

  const renderMeta = (meta: SelectOptionMeta) => {
    const hasAny = meta.intel !== undefined || meta.speedTps !== undefined || meta.speed !== undefined || meta.price !== undefined;
    if (!hasAny) return null;
    return (
      <span className={s.metaRow}>
        {meta.intel !== undefined && renderIntel(meta.intel)}
        {meta.speedTps !== undefined && renderSpeedTps(meta.speedTps)}
        {meta.speed !== undefined && renderSpeedScale(meta.speed)}
        {meta.price !== undefined && renderPrice(meta.price)}
      </span>
    );
  };

  return (
    <div className={s.root} ref={rootRef}>
      <button
        className={s.trigger}
        onClick={() => { if (!disabled) setIsOpen((v) => !v); }}
        disabled={disabled}
        type="button"
      >
        {!value ? (
          <span className={s.triggerPlaceholder}>{placeholder}</span>
        ) : (
          <span className={s.triggerContent}>
            {selectedLabel}
          </span>
        )}
        <span className={`${s.triggerArrow} ${isOpen ? s.triggerArrowOpen : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className={s.dropdown}>
          {searchable && (
            <div className={s.searchWrap}>
              <input
                ref={searchRef}
                className={s.searchInput}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common.searchPlaceholder')}
              />
            </div>
          )}
          <div className={s.list} style={{ maxHeight: `${maxVisibleItems * 44}px` }}>
            {filtered.map((opt) => (
              <button
                key={opt.value}
                className={`${s.option} ${opt.value === value ? s.optionActive : ''}`}
                onClick={() => handleSelect(opt.value)}
                type="button"
              >
                <div className={s.optionMain}>
                  <span className={s.optionLabel}>{opt.label}</span>
                  {opt.badge && renderBadge(opt.badge)}
                </div>
                {opt.hint && <span className={s.optionHint}>{opt.hint}</span>}
                {opt.meta && renderMeta(opt.meta)}
              </button>
            ))}

            {filtered.length === 0 && (
              <div className={s.emptyState}>{t('common.nothingFound')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
