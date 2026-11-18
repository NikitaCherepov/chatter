import { forwardRef, useCallback, useEffect, useLayoutEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import { MessageViewportContext, useMessageViewport } from './VirtualMessage';
import Lenis, { type LenisOptions } from 'lenis';
import 'lenis/dist/lenis.css';

export const CHAT_MESSAGES_SCROLL_LERP = 0.12;
export const CHAT_MESSAGES_LENIS_ENABLED = false;

const CHAT_MESSAGES_LENIS_OPTIONS = {
  autoRaf: true,
  lerp: CHAT_MESSAGES_SCROLL_LERP,
  smoothWheel: true,
  overscroll: true,
  respectReducedMotion: true,
} satisfies LenisOptions;

export type ChatMessagesScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
};

export type ChatMessagesScrollHandle = {
  getMetrics: () => ChatMessagesScrollMetrics | null;
  scrollTo: (target: number | 'end', options?: { immediate?: boolean }) => void;
  scrollToMessage: (messageId: number, options?: { immediate?: boolean }) => boolean;
};

type SavedPosition = {
  top: number;
  bottom: boolean;
  anchor?: { messageId: string; offset: number; bodyOffset: number };
};

type Props = {
  className: string;
  contentClassName: string;
  resetKey: number | null;
  positionScope?: string;
  ready?: boolean;
  virtualize?: boolean;
  children: ReactNode;
};

export const ChatMessagesScroll = forwardRef<ChatMessagesScrollHandle, Props>(function ChatMessagesScroll({
  className,
  contentClassName,
  resetKey,
  positionScope = '',
  ready = true,
  virtualize = false,
  children,
}, ref) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const positionsRef = useRef(new Map<string, SavedPosition>());
  const restoredKeyRef = useRef<string | null>(null);
  const positionKey = resetKey === null ? null : `${positionScope}:${resetKey}`;
  const viewport = useMessageViewport(wrapperRef, positionKey, ready && virtualize);
  const jumpVersionRef = useRef(0);
  const readPosition = useCallback((wrapper: HTMLDivElement): SavedPosition => {
    const position: SavedPosition = {
      top: wrapper.scrollTop,
      bottom: wrapper.scrollHeight - wrapper.clientHeight - wrapper.scrollTop <= 4,
    };
    if (!virtualize || position.bottom) return position;
    const top = wrapper.getBoundingClientRect().top;
    for (const row of contentRef.current?.querySelectorAll<HTMLElement>('[data-virtual-message-id]') ?? []) {
      const element = row.querySelector<HTMLElement>('[data-message-id]') ?? row;
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      position.anchor = {
        messageId: row.dataset.virtualMessageId!,
        offset: rect.top - top,
        bodyOffset: rect.top - row.getBoundingClientRect().top,
      };
      break;
    }
    return position;
  }, [virtualize]);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (restoredKeyRef.current !== positionKey) {
      restoredKeyRef.current = null;
      jumpVersionRef.current++;
    }
    if (!wrapper || !ready || positionKey === null || restoredKeyRef.current === positionKey) return;
    restoredKeyRef.current = positionKey;
    const saved = positionsRef.current.get(positionKey);
    wrapper.scrollTo({ top: !saved || saved.bottom ? wrapper.scrollHeight : saved.top, behavior: 'instant' });
    positionsRef.current.set(positionKey, { ...readPosition(wrapper), bottom: !saved || saved.bottom });
    if (positionsRef.current.size > 100) positionsRef.current.delete(positionsRef.current.keys().next().value!);
  }, [positionKey, ready, children, readPosition]);

  // Images and background history refreshes can change height after restoration.
  // Keep a chat that was left at the bottom pinned there without animating.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !ready || positionKey === null) return;
    const observer = new ResizeObserver(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper || restoredKeyRef.current !== positionKey) return;
      const saved = positionsRef.current.get(positionKey);
      if (saved?.bottom) {
        wrapper.scrollTo({ top: wrapper.scrollHeight, behavior: 'instant' });
      } else if (saved?.anchor && Math.abs(saved.top - wrapper.scrollTop) < 1) {
        const row = content.querySelector<HTMLElement>('[data-virtual-message-id="' + saved.anchor.messageId + '"]');
        const element = row?.querySelector<HTMLElement>('[data-message-id]') ?? row;
        if (!element) return;
        const delta = element.getBoundingClientRect().top
          + (element === row ? saved.anchor.bodyOffset : 0)
          - wrapper.getBoundingClientRect().top - saved.anchor.offset;
        if (Math.abs(delta) >= 0.5) {
          wrapper.scrollTo({ top: wrapper.scrollTop + delta, behavior: 'instant' });
          positionsRef.current.set(positionKey, { ...saved, top: wrapper.scrollTop });
        }
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [positionKey, ready]);

  useEffect(() => {
    if (!CHAT_MESSAGES_LENIS_ENABLED) return;
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const lenis = new Lenis({
      ...CHAT_MESSAGES_LENIS_OPTIONS,
      wrapper,
      content,
    });
    lenisRef.current = lenis;
    return () => {
      lenisRef.current = null;
      lenis.destroy();
    };
  }, [resetKey]);

  useImperativeHandle(ref, () => ({
    getMetrics: () => {
      const wrapper = wrapperRef.current;
      return wrapper
        ? { scrollHeight: wrapper.scrollHeight, scrollTop: wrapper.scrollTop }
        : null;
    },
    scrollTo: (target, options) => {
      jumpVersionRef.current++;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const lenis = lenisRef.current;
      if (lenis) {
        lenis.resize();
        lenis.scrollTo(target, options);
        return;
      }
      wrapper.scrollTo({
        top: target === 'end' ? wrapper.scrollHeight : target,
        behavior: options?.immediate ? 'auto' : 'smooth',
      });
      if (positionKey !== null) positionsRef.current.set(positionKey, readPosition(wrapper));
    },
    scrollToMessage: (messageId, options) => {
      const wrapper = wrapperRef.current;
      const content = contentRef.current;
      if (!wrapper || !content) return false;
      const version = ++jumpVersionRef.current;
      const scroll = () => {
        if (version !== jumpVersionRef.current) return;
        const target = content.querySelector<HTMLElement>('[data-message-id="' + messageId + '"]');
        if (!target) return;
        const targetRect = target.getBoundingClientRect();
        const top = wrapper.scrollTop + targetRect.top - wrapper.getBoundingClientRect().top
          - Math.max(0, (wrapper.clientHeight - targetRect.height) / 2);
        const lenis = lenisRef.current;
        if (lenis) {
          lenis.resize();
          lenis.scrollTo(top, options);
        } else wrapper.scrollTo({ top, behavior: options?.immediate ? 'auto' : 'smooth' });
        if (positionKey !== null) positionsRef.current.set(positionKey, readPosition(wrapper));
      };
      if (viewport.reveal(messageId, scroll)) return true;
      if (!content.querySelector('[data-message-id="' + messageId + '"]')) return false;
      scroll();
      return true;
    },
  }), [viewport, positionKey, readPosition]);

  return (
    <div className={className} ref={wrapperRef} style={{ overflowAnchor: 'none' }} onClickCapture={(event) => {
      // A deliberate disclosure click means reading in place, not following the bottom.
      // Run before the toggle changes layout and before ResizeObserver sees its animation.
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('summary, button[aria-expanded]')) return;
      const wrapper = wrapperRef.current;
      if (!wrapper || positionKey === null || restoredKeyRef.current !== positionKey) return;
      positionsRef.current.set(positionKey, { ...readPosition(wrapper), bottom: false });
    }} onScroll={() => {
      const wrapper = wrapperRef.current;
      if (!wrapper || !ready || positionKey === null || restoredKeyRef.current !== positionKey) return;
      // A delayed event for an already recorded scroll must not replace its anchor
      // with geometry that may have changed since the scroll actually happened.
      if (positionsRef.current.get(positionKey)?.top === wrapper.scrollTop) return;
      positionsRef.current.set(positionKey, readPosition(wrapper));
    }}>
      <div className={contentClassName} ref={contentRef}>
        <MessageViewportContext.Provider key={positionKey} value={viewport}>{children}</MessageViewportContext.Provider>
      </div>
    </div>
  );
});
