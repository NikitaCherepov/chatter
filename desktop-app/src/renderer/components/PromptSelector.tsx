import React, { useState, useRef, useEffect, useMemo } from 'react';
import s from './PromptSelector.module.scss';

type PromptOption = {
  id: number;
  name: string;
  description: string;
};

type Props = {
  options: PromptOption[];
  value: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
  placeholder?: string;
  maxVisibleItems?: number;
};

const CUSTOM_ID = -1;

export function PromptSelector({ options, value, onChange, disabled = false, placeholder = 'Выберите промпт...', maxVisibleItems = 6 }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return options;
    return options.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    );
  }, [search, options]);

  const selectedLabel = useMemo(() => {
    if (value === CUSTOM_ID) return 'Кастомный';
    const found = options.find((p) => p.id === value);
    return found ? found.name : placeholder;
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
    if (isOpen) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const handleSelect = (id: number) => {
    onChange(id);
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
        {value === null ? (
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
          <div className={s.list} style={{ maxHeight: `${maxVisibleItems * 52}px` }}>
            {filtered.map((p) => (
              <button
                key={p.id}
                className={`${s.option} ${p.id === value ? s.optionActive : ''}`}
                onClick={() => handleSelect(p.id)}
                type="button"
              >
                <span className={s.optionName}>{p.name}</span>
                <span className={s.optionDesc}>{p.description}</span>
              </button>
            ))}

            {filtered.length === 0 && (
              <div className={s.emptyState}>Ничего не найдено</div>
            )}

            <div className={s.customDivider} />
            <button
              className={`${s.option} ${value === CUSTOM_ID ? s.optionActive : ''}`}
              onClick={() => handleSelect(CUSTOM_ID)}
              type="button"
            >
              <span className={s.optionName}>Кастомный</span>
              <span className={s.optionDesc}>Напишите свой промпт</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
