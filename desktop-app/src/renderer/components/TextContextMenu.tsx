import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import s from './TextContextMenu.module.scss';

type MenuState = Parameters<Parameters<Window['electronAPI']['onTextContextMenu']>[0]>[0];
type Action = MenuState['items'][number]['action'];

export function TextContextMenu() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const modifier = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const shortcuts: Record<Action, string> = {
    undo: `${modifier}Z`, redo: window.electronAPI.platform === 'darwin' ? '⌘⇧Z' : 'Ctrl+Y',
    cut: `${modifier}X`, copy: `${modifier}C`, paste: `${modifier}V`, selectAll: `${modifier}A`,
  };

  useEffect(() => {
    let clickPosition: { x: number; y: number } | null = null;
    const rememberClick = (event: MouseEvent) => {
      // DOM coordinates already match CSS pixels, including Electron zoom/DPI.
      clickPosition = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('contextmenu', rememberClick, true);
    const unsubscribe = window.electronAPI.onTextContextMenu(next => {
      setMenu({ ...next, ...clickPosition });
      clickPosition = null;
      setActive(-1);
    });
    return () => {
      document.removeEventListener('contextmenu', rememberClick, true);
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    if (!menu || !rootRef.current) return;
    // Animation transforms must not affect the final viewport bounds.
    const { offsetWidth: width, offsetHeight: height } = rootRef.current;
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const pointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
        }
        close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const enabled = menu.items.map((item, index) => item.enabled ? index : -1).filter(index => index >= 0);
        if (!enabled.length) return;
        const index = enabled.indexOf(active);
        setActive(enabled[index < 0 ? (event.key === 'ArrowDown' ? 0 : enabled.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const item = menu.items[active];
        if (item?.enabled) {
          void window.electronAPI.textContextMenuAction(item.action).catch(console.error);
          close();
        }
      } else {
        close();
      }
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [menu, active]);

  return createPortal(<AnimatePresence>
    {menu && <motion.div
      ref={rootRef}
      className={s.menu}
      role="menu"
      aria-label={t('common.actions')}
      aria-activedescendant={active >= 0 ? `text-menu-${menu.items[active].action}` : undefined}
      style={position}
      initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.96, y: reducedMotion ? 0 : -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.98 }}
      transition={{ duration: reducedMotion ? 0 : 0.12, ease: 'easeOut' }}
      onPointerDown={event => event.preventDefault()}
      onContextMenu={event => event.preventDefault()}
    >
      {menu.items.map((item, index) => <React.Fragment key={item.action}>
        {item.separator && <div className={s.separator} role="separator" />}
        <button
          id={`text-menu-${item.action}`}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={!item.enabled}
          className={`${s.item} ${active === index ? s.active : ''}`}
          onMouseEnter={() => setActive(item.enabled ? index : -1)}
          onClick={() => {
            void window.electronAPI.textContextMenuAction(item.action).catch(console.error);
            setMenu(null);
          }}
        >
          <span>{t(`common.${item.action}`)}</span>
          <span className={s.shortcut}>{shortcuts[item.action]}</span>
        </button>
      </React.Fragment>)}
    </motion.div>}
  </AnimatePresence>, document.body);
}
