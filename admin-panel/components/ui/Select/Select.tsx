'use client';

import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
import styles from './Select.module.css';

/** Limited set of badge colors — each comes from a CSS variable. */
export type BadgeColor = 'success' | 'error' | 'info' | 'warning';

/** Badge for an option: if no icon is provided — the text is rendered in [brackets]. */
export type SelectBadge = {
  /** Badge text (used for title, and for [bracketed] display when icon is missing) */
  text: string;
  /** Color. Defaults to 'success' */
  color?: BadgeColor;
  /** Custom icon. If not provided — [text] is rendered */
  icon?: ReactNode;
};

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  badge?: SelectBadge;
  /** Disable this option — shown greyed-out, not clickable, aria-disabled. */
  disabled?: boolean;
};

type Props = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  searchable?: boolean;
  maxVisibleItems?: number;
};

/**
 * Reusable Select.
 *
 * Styles mirror desktop-app/src/renderer/components/Select.tsx 1:1 —
 * synced with the global CSS variables from globals.css.
 *
 * Localization is passed by the caller via props
 * (placeholder/searchPlaceholder/emptyText), so the component is not
 * tied to any specific i18n namespace.
 */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder = 'Поиск…',
  emptyText = 'Ничего не найдено',
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

  const selectedLabel = selectedOption ? selectedOption.label : (placeholder ?? '');

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
      <span className={styles.badge} style={{ color: colorVar }} title={badge.text}>
        {badge.icon ?? `[${badge.text}]`}
      </span>
    );
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={styles.trigger}
        onClick={() => {
          if (!disabled) setIsOpen((v) => !v);
        }}
        disabled={disabled}
        type="button"
      >
        {!value ? (
          <span className={styles.triggerPlaceholder}>{placeholder}</span>
        ) : (
          <span className={styles.triggerContent}>{selectedLabel}</span>
        )}
        <span className={`${styles.triggerArrow} ${isOpen ? styles.triggerArrowOpen : ''}`}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          {searchable && (
            <div className={styles.searchWrap}>
              <input
                ref={searchRef}
                className={styles.searchInput}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
              />
            </div>
          )}
          <div className={styles.list} style={{ maxHeight: `${maxVisibleItems * 44}px` }}>
            {filtered.map((opt) => (
              <button
                key={opt.value}
                className={`${styles.option} ${opt.value === value ? styles.optionActive : ''} ${opt.disabled ? styles.optionDisabled : ''}`}
                onClick={() => {
                  if (!opt.disabled) handleSelect(opt.value);
                }}
                type="button"
                disabled={opt.disabled}
                aria-disabled={opt.disabled}
              >
                <div className={styles.optionMain}>
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {opt.badge && renderBadge(opt.badge)}
                </div>
                {opt.hint && <span className={styles.optionHint}>{opt.hint}</span>}
              </button>
            ))}

            {filtered.length === 0 && <div className={styles.emptyState}>{emptyText}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
