import React, { useState, useCallback } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import type { LayoutMode } from '../lib/tools';
import s from './FloatingWidget.module.scss';

type Props = {
  /** Unique id for @dnd-kit (e.g. "floating-notebook") */
  dragId: string;
  layoutMode: LayoutMode;
  /** Current floating position (from tools.ts state) */
  floatingPos: { x: number; y: number };
  /** Called when user finishes dragging (delta from last position) */
  onFloatingPosChange: (pos: { x: number; y: number }) => void;
  /** Called when user changes layout mode via header buttons */
  onLayoutChange: (mode: LayoutMode) => void;
  /** Called when user clicks close (X) button */
  onClose: () => void;
  /** Header title (tool name) */
  title: string;
  children: React.ReactNode;
};

/**
 * Wrapper that renders children in one of three layout modes:
 * - 'sidebar' — renders as-is (no wrapper)
 * - 'fullscreen' — position:fixed, inset:0
 * - 'floating' — position:fixed, draggable via @dnd-kit
 */
export function FloatingWidget({
  dragId,
  layoutMode,
  floatingPos,
  onFloatingPosChange,
  onLayoutChange,
  onClose,
  title,
  children,
}: Props) {
  const { t } = useTranslation();
  const [exiting, setExiting] = useState(false);
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: dragId,
  });

  const handleClose = useCallback(() => {
    setExiting(true);
  }, []);

  const handleAnimationEnd = useCallback(() => {
    if (exiting) {
      onClose();
    }
  }, [exiting, onClose]);

  const style: React.CSSProperties =
    layoutMode === 'floating'
      ? {
          position: 'fixed',
          left: floatingPos.x,
          top: floatingPos.y,
          width: 420,
          height: 520,
          zIndex: 50,
          transform: CSS.Translate.toString(transform),
        }
      : layoutMode === 'fullscreen'
        ? {
            position: 'fixed',
            top: window.electronAPI ? 'calc(var(--titlebar-height) + 1px)' : 0,
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 100,
          }
        : {}; // sidebar — no positioning

  if (layoutMode === 'sidebar') {
    return <>{children}</>;
  }

  const cls = exiting ? `${s[layoutMode]} ${s.exiting}` : s[layoutMode];

  return (
    <div
      ref={setNodeRef}
      className={cls}
      style={style}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Header — buttons are outside drag zone */}
      <div className={s.header}>
        {/* Drag handle — only this area triggers drag */}
        <div className={s.dragHandle} {...listeners} {...attributes}>
          <span className={s.headerTitle}>{title}</span>
        </div>
        <div className={s.headerBtns}>
          <button
            className={s.modeBtn}
            onClick={() => onLayoutChange('external')}
            title={t('widget.external', { defaultValue: 'Open in separate window' })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </button>
          <button
            className={s.modeBtn}
            onClick={() => onLayoutChange('sidebar')}
            title={t('widget.toSidebar')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          {layoutMode === 'fullscreen' ? (
            <button
              className={s.modeBtn}
              onClick={() => onLayoutChange('floating')}
              title={t('widget.floating')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="14" height="14" rx="2" ry="2" />
              </svg>
            </button>
          ) : (
            <button
              className={s.modeBtn}
              onClick={() => onLayoutChange('fullscreen')}
              title={t('widget.fullscreen')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          <button
            className={s.modeBtn}
            onClick={handleClose}
            title={t('common.close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className={s.body}>{children}</div>
    </div>
  );
}
