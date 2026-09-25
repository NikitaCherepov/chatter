import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
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
};

type Props = {
  className: string;
  contentClassName: string;
  resetKey: number | null;
  children: ReactNode;
};

export const ChatMessagesScroll = forwardRef<ChatMessagesScrollHandle, Props>(function ChatMessagesScroll({
  className,
  contentClassName,
  resetKey,
  children,
}, ref) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lenisRef = useRef<Lenis | null>(null);

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
    },
  }), []);

  return (
    <div className={className} ref={wrapperRef}>
      <div className={contentClassName} ref={contentRef}>
        {children}
      </div>
    </div>
  );
});
