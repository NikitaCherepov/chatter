import React, { useState, useRef, useEffect, useMemo } from 'react';
import s from './Select.module.scss';

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
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

  const selectedLabel = useMemo(() => {
    const found = options.find((o) => o.value === value);
    return found ? found.label : placeholder;
  }, [value, options, placeholder]);

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
          <span>{selectedLabel}</span>
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
                <span className={s.optionLabel}>{opt.label}</span>
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
