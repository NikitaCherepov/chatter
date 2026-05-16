import React, { useState, useRef, useEffect, useCallback } from 'react';
import s from './Select.module.scss';

export type SelectOption = {
  value: string;
  label: string;
};

type Props = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export function Select({ options, value, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open, handleClickOutside]);

  return (
    <div ref={containerRef} className={`${s.root} ${className || ''}`}>
      <button
        className={s.trigger}
        onClick={() => setOpen(prev => !prev)}
        type="button"
      >
        <span className={s.triggerLabel}>{current?.label || ''}</span>
        <svg
          className={`${s.chevron} ${open ? s.chevronOpen : ''}`}
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className={s.dropdown}>
          {options.map(opt => (
            <button
              key={opt.value}
              className={`${s.option} ${opt.value === value ? s.optionActive : ''}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
