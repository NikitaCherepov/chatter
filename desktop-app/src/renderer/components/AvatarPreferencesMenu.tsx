import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { FeatureFlags } from '../lib/api';
import toggle from './MemoryPopover.module.scss';
import s from './AvatarPreferencesMenu.module.scss';
export function AvatarPreferencesMenu({ children, className, flags, saving, setFlag }: {
  children: ReactNode; className: string; flags: FeatureFlags; saving: boolean;
  setFlag: (key: keyof FeatureFlags, value: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const hidden = Boolean(flags.hide_pixel_avatar);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); };
  }, [open]);
  return <>
    {!hidden && <button ref={trigger} type="button" className={`${className} ${s.trigger}`} data-message-avatar
      aria-label={t('settings.avatar.menu')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(box.right + 10, window.innerWidth - 288)), top: Math.max(8, Math.min(box.top, window.innerHeight - 230)) });
        setOpen(value => !value);
      }}>{children}</button>}
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={t('settings.avatar.menu')}
      className={s.panel} style={position} onClick={event => event.stopPropagation()}>
      <div className={s.heading}><span>{t('settings.avatar.menu')}</span><button type="button" aria-label={t('common.close')} onClick={close}>×</button></div>
      <div className={s.row}><span id={`${id}-show`}>{t('settings.avatar.show')}</span>
        <button type="button" role="switch" aria-labelledby={`${id}-show`} aria-checked={!hidden} disabled={saving}
          className={`${toggle.toggle} ${!hidden ? toggle.toggleActive : ''}`} onClick={() => setFlag('hide_pixel_avatar', !hidden)}><span /></button></div>
      <div className={s.row}><span id={`${id}-control`}>{t('settings.avatar.control')}</span>
        <button type="button" role="switch" aria-labelledby={`${id}-control`} aria-checked={!hidden && !flags.disable_avatar_control} disabled={saving || hidden}
          className={`${toggle.toggle} ${!hidden && !flags.disable_avatar_control ? toggle.toggleActive : ''}`}
          onClick={() => setFlag('disable_avatar_control', !flags.disable_avatar_control)}><span /></button></div>
      <p>{t(hidden ? 'settings.avatar.hiddenHint' : 'settings.avatar.menuHint')}</p>
    </div>, document.body)}
  </>;
}
