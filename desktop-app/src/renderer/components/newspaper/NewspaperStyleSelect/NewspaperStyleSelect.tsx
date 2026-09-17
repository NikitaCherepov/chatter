import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { NewspaperVisualStyle } from '../types';
import s from './NewspaperStyleSelect.module.scss';

export type NewspaperStyleOption = {
  value: NewspaperVisualStyle;
  label: string;
  hint: string;
};

type Props = {
  options: NewspaperStyleOption[];
  value: NewspaperVisualStyle;
  onChange: (value: NewspaperVisualStyle) => void;
};

export function NewspaperStyleSelect({ options, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find(option => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return <div className={s.root} data-style={value} ref={rootRef}>
    <button
      type="button"
      className={s.trigger}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => setOpen(current => !current)}
    >
      <span className={s.signal}>{value === 'deusEx' ? 'ACTIVE SKIN' : value === 'massEffect' ? 'ACTIVE PROFILE' : value === 'wizarding' ? 'ТЕКУЩИЙ ВЫПУСК' : 'CURRENT EDITION'}</span>
      <span className={s.selection}><strong>{selected.label}</strong><i>{open ? '−' : '+'}</i></span>
      <small>{selected.hint}</small>
    </button>
    <AnimatePresence initial={false}>{open && <motion.div
      id={listId}
      className={s.options}
      role="listbox"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: .16, ease: 'easeOut' }}
    >
      {options.map((option, index) => <button
        key={option.value}
        type="button"
        className={s.option}
        role="option"
        aria-selected={option.value === value}
        onClick={() => {
          onChange(option.value);
          setOpen(false);
        }}
      >
        <span className={s.optionIndex}>{String(index + 1).padStart(2, '0')}</span>
        <span><strong>{option.label}</strong><small>{option.hint}</small></span>
      </button>)}
    </motion.div>}</AnimatePresence>
  </div>;
}
