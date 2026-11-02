import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { FeatureFlags } from '../lib/api';
import toggle from './MemoryPopover.module.scss';
import s from './AvatarPreferencesMenu.module.scss';
export function AvatarPreferencesMenu({ children, className, flags, saving, setFlag }: {
  children: ReactNode; className: string; flags: FeatureFlags; saving: boolean;
  setFlag: (key: keyof FeatureFlags, value: boolean) => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ left: 0, top: 0, height: 40, labelsLeft: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const hidden = Boolean(flags.hide_pixel_avatar);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); };
  }, [open]);
  const controls = [
    { key: 'show', checked: !hidden, disabled: saving, label: 'show', short: 'showShort', change: () => setFlag('hide_pixel_avatar', !hidden) },
    { key: 'control', checked: !hidden && !flags.disable_avatar_control, disabled: saving || hidden, label: 'control', short: 'controlShort', change: () => setFlag('disable_avatar_control', !flags.disable_avatar_control) },
  ];
  return <>
    <button ref={trigger} type="button" className={`${className} ${s.trigger}`} data-message-avatar
      aria-label={t('settings.avatar.menu')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect();
        setAnchor({ left: Math.max(8, box.left + box.width / 2 - 17), top: Math.max(46, Math.min(box.top, window.innerHeight - box.height - 46)), height: box.height, labelsLeft: box.left > window.innerWidth - 240 });
        setOpen(value => !value);
      }}>{children}</button>
    {createPortal(<AnimatePresence>{open && <div ref={panel} id={id} role="dialog" aria-label={t('settings.avatar.menu')} aria-describedby={`${id}-hint`}
      className={`${s.orbit} ${anchor.labelsLeft ? s.labelsLeft : ''}`} style={{ left: anchor.left, top: anchor.top, height: anchor.height }} onClick={event => event.stopPropagation()}>
      {controls.map((control, index) => <motion.button key={control.key} type="button" role="switch"
        aria-label={t(`settings.avatar.${control.label}`)} aria-checked={control.checked} disabled={control.disabled}
        title={t(hidden ? 'settings.avatar.hiddenHint' : 'settings.avatar.menuHint')}
        onClick={control.change} className={`${s.control} ${index === 0 ? s.above : s.below}`}
        initial={{ opacity: 0, y: reducedMotion ? 0 : index === 0 ? 5 : -5, scale: reducedMotion ? 1 : .96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: reducedMotion ? 0 : index === 0 ? 4 : -4 }}
        transition={{ duration: reducedMotion ? 0 : .15 }}>
        <span className={`${toggle.toggle} ${control.checked ? toggle.toggleActive : ''}`} aria-hidden="true"><span /></span>
        <span className={s.label}>{t(`settings.avatar.${control.short}`)}</span>
      </motion.button>)}
      <span id={`${id}-hint`} className={s.srOnly}>{t(hidden ? 'settings.avatar.hiddenHint' : 'settings.avatar.menuHint')}</span>
    </div>}</AnimatePresence>, document.body)}
  </>;
}
