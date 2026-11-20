import { useLayoutEffect, useRef, type ReactNode } from 'react';
import s from './ChatComposerDock.module.scss';

/** Keep the conversation viewport fixed while reserving room for its floating composer. */
export function ChatComposerDock({
  children,
  compact = false,
  mode = 'floating',
}: {
  children: ReactNode;
  compact?: boolean;
  mode?: 'floating' | 'docked';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = ref.current,
      parent = dock?.parentElement;
    if (!dock || !parent || mode === 'docked') return;
    const viewport = parent.querySelector<HTMLElement>('[data-chat-messages]');
    let previous = '';
    const measure = () => {
      const height = Math.ceil(dock.getBoundingClientRect().height) + 'px';
      if (height === previous) return;
      previous = height;
      const atBottom =
        viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4;
      parent.style.setProperty('--chat-composer-height', height);
      // Match the message scroller's existing bottom-follow behavior without
      // pulling a user away from an older message they are reading.
      if (atBottom && viewport) viewport.scrollTop = viewport.scrollHeight;
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    });
    observer.observe(dock);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      parent.style.removeProperty('--chat-composer-height');
    };
  }, [mode]);
  return (
    <div ref={ref} data-chat-composer-dock data-composer-mode={mode} className={`${s.dock} ${compact ? s.compact : ''} ${mode === 'docked' ? s.docked : ''}`}>
      {children}
    </div>
  );
}
