import React, { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
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

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  badge?: SelectBadge;
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
  placeholder = 'Выберите...',
  disabled = false,
  searchable = false,
  maxVisibleItems = 8,
}: Props) {
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

  const selectedLabel = selectedOption ? selectedOption.label : placeholder;

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
            {selectedOption?.badge && renderBadge(selectedOption.badge)}
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
                placeholder="Поиск..."
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
              </button>
            ))}

            {filtered.length === 0 && (
              <div className={s.emptyState}>Ничего не найдено</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
