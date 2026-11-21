import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTab } from '../lib/chat-workspace';
import s from './ChatWorkspaceNav.module.scss';

export function ChatWorkspaceBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const layout = bar?.closest<HTMLElement>('[data-layout-side]');
    if (!bar || !layout) return;
    const measure = () => {
      const bottom = bar.getBoundingClientRect().bottom - layout.getBoundingClientRect().top - layout.clientTop;
      layout.style.setProperty('--workspace-nav-bottom', `${bottom}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    observer.observe(layout);
    return () => {
      observer.disconnect();
      layout.style.removeProperty('--workspace-nav-bottom');
    };
  }, []);

  return <div ref={ref} className={s.bar} data-workspace-nav>{children}</div>;
}

export function WorkspacePin({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m16 3 5 5-3 2-2 5-2 2-7-7 2-2 5-2zM10.5 13.5 4 20" />
    </svg>
  );
}

function revealTab(scroller: HTMLDivElement | null, active: HTMLButtonElement | null) {
  const tab = active?.parentElement;
  if (!scroller || !tab) return;
  const stripBounds = scroller.getBoundingClientRect();
  const tabBounds = tab.getBoundingClientRect();
  if (tabBounds.left < stripBounds.left || tabBounds.width > stripBounds.width) {
    scroller.scrollLeft += tabBounds.left - stripBounds.left;
  } else if (tabBounds.right > stripBounds.right) {
    scroller.scrollLeft += tabBounds.right - stripBounds.right;
  }
}

export function ChatWorkspaceTabs({
  tabs, activeId, libraryOpen, libraryTrigger, onToggleLibrary, onSelect, onClose, onPin,
}: {
  tabs: WorkspaceTab[];
  activeId: number | null;
  libraryOpen: boolean;
  libraryTrigger: RefObject<HTMLButtonElement>;
  onToggleLibrary: () => void;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onPin: (id: number) => void;
}) {
  const { t } = useTranslation();
  const selected = useRef<HTMLButtonElement>(null);
  const tabLane = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const tabItems = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });

  useLayoutEffect(() => {
    const lane = tabLane.current;
    const list = tabList.current;
    const items = tabItems.current;
    if (!lane || !list || !items) return;
    let listWidth = list.clientWidth;
    const updateArrows = () => {
      // Measure the lane independently of the buttons that consume part of it.
      const overflow = items.getBoundingClientRect().width - lane.getBoundingClientRect().width > 1;
      const left = overflow && list.scrollLeft > 1;
      const right = overflow && list.scrollWidth - list.clientWidth - list.scrollLeft > 1;
      setScroll(previous => previous.overflow === overflow && previous.left === left && previous.right === right
        ? previous : { overflow, left, right });
    };
    const observer = new ResizeObserver(() => {
      if (list.clientWidth !== listWidth) {
        listWidth = list.clientWidth;
        revealTab(list, selected.current);
      }
      updateArrows();
    });
    observer.observe(lane);
    observer.observe(list);
    observer.observe(items);

    const onWheel = (event: WheelEvent) => {
      if (event.deltaX || !event.deltaY || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth : 1;
      const previous = list.scrollLeft;
      list.scrollLeft += event.deltaY * scale;
      if (list.scrollLeft !== previous) event.preventDefault();
    };
    list.addEventListener('wheel', onWheel, { passive: false });
    list.addEventListener('scroll', updateArrows, { passive: true });
    updateArrows();
    return () => {
      observer.disconnect();
      list.removeEventListener('wheel', onWheel);
      list.removeEventListener('scroll', updateArrows);
    };
  }, []);

  useLayoutEffect(() => {
    revealTab(tabList.current, selected.current);
  }, [activeId, tabs.length, scroll.overflow]);

  const scrollButton = (direction: 'left' | 'right') => {
    const label = t(direction === 'left' ? 'chatWorkspace.scrollTabsLeft' : 'chatWorkspace.scrollTabsRight');
    const enabled = scroll[direction];
    return (
      <button type="button" className={`${s.iconButton} ${s.tabScrollButton}`}
        aria-disabled={!enabled} tabIndex={enabled ? 0 : -1} aria-label={label} title={label}
        onClick={() => {
          const list = tabList.current;
          if (!enabled || !list) return;
          list.scrollBy({
            left: (direction === 'left' ? -1 : 1) * list.clientWidth * 0.75,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
          });
        }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={direction === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
        </svg>
      </button>
    );
  };

  return (
    <nav className={s.chats} aria-label={t('chat.sidebar.chats')}>
      <button ref={libraryTrigger} type="button" className={s.action}
        aria-expanded={libraryOpen} aria-controls="chat-library" onClick={onToggleLibrary}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m-4-11h2m-2 4h2" />
        </svg>
        <span>{t('chatWorkspace.allChats')}</span>
      </button>
      <div className={s.tabLane} ref={tabLane}>
        {scroll.overflow && scrollButton('left')}
        <div className={s.tabs} ref={tabList} data-workspace-tab-strip>
          <div className={s.tabItems} ref={tabItems}>
            {tabs.map((tab, index) => {
              const title = tab.title || t('chatWorkspace.untitled', { id: tab.id });
              const active = tab.id === activeId;
              return (
                <div className={s.tab} data-active={active} data-pinned={tab.pinned} key={tab.id}>
                  <button type="button" className={s.tabLink} ref={active ? selected : undefined}
                    data-workspace-chat={tab.id} aria-current={active ? 'page' : undefined} onClick={() => onSelect(tab.id)} title={title}>
                    <span className={s.tabMark} aria-hidden="true">{[...title.trim()][0]?.toUpperCase()}</span>
                    <span className={s.tabText}>{title}</span>
                  </button>
                  <button type="button" className={s.iconButton} aria-pressed={tab.pinned}
                    title={t(tab.pinned ? 'chatWorkspace.unpin' : 'chatWorkspace.pin')}
                    aria-label={t(tab.pinned ? 'chatWorkspace.unpinChat' : 'chatWorkspace.pinChat', { title })}
                    onClick={() => onPin(tab.id)}>
                    <WorkspacePin filled={tab.pinned} />
                  </button>
                  <button type="button" className={s.iconButton}
                    title={t('chatWorkspace.closeTab')} aria-label={t('chatWorkspace.closeChat', { title })}
                    onClick={() => {
                      const next = tabs[index + 1] ?? tabs[index - 1];
                      const nextButton = next && tabList.current?.querySelector<HTMLButtonElement>(`[data-workspace-chat="${next.id}"]`);
                      (nextButton || libraryTrigger.current)?.focus({ preventScroll: true });
                      onClose(tab.id);
                    }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="m6 6 12 12M18 6 6 18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        {scroll.overflow && scrollButton('right')}
      </div>
    </nav>
  );
}
