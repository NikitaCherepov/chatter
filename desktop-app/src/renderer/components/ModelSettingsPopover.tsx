import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './ModelSettingsPopover.module.scss';

export function ModelSettingsPopover({ label, className, children }: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`${s.root} ${className || ''}`}>
      <button ref={triggerRef} type="button" className={s.trigger} title={label}
        aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span>{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && <div className={s.panel}>
        <div className={s.heading}>
          <span>{t('chat.model.label')}</span>
          <button type="button" aria-label={t('common.close')} onClick={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}>×</button>
        </div>
        {children}
      </div>}
    </div>
  );
}
