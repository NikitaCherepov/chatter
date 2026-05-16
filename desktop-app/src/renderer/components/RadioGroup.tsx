import React, { useState, useRef, useEffect, useCallback } from 'react';
import s from './RadioGroup.module.scss';

export type RadioOption = {
  value: string;
  label: string;
};

type Props = {
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  /** Icon element rendered inside the trigger button */
  icon?: React.ReactNode;
  className?: string;
};

export function RadioGroup({ options, value, onChange, icon, className }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
        className={`${s.trigger} ${open ? s.triggerActive : ''}`}
        onClick={() => setOpen(prev => !prev)}
        type="button"
      >
        {icon || (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
            <line x1="8" y1="2" x2="8" y2="18" />
            <line x1="16" y1="6" x2="16" y2="22" />
          </svg>
        )}
      </button>

      {open && (
        <div className={s.dropdown}>
          {options.map(opt => (
            <label key={opt.value} className={s.option}>
              <span className={`${s.radio} ${opt.value === value ? s.radioChecked : ''}`}>
                {opt.value === value && <span className={s.radioDot} />}
              </span>
              <span className={s.optionLabel}>{opt.label}</span>
              <input
                type="radio"
                className={s.hiddenInput}
                checked={opt.value === value}
                onChange={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
