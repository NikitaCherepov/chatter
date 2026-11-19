import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import s from './VirtualRows.module.scss';

type Row = {
  visibility: (nearby: boolean) => void;
  reveal: (ready?: () => void) => void;
  remeasure: () => void;
  release: () => void;
  resize: () => void;
};
type Viewport = {
  register: (element: HTMLElement, row: Row) => () => void;
  protected: () => boolean;
  nearby: (element: HTMLElement) => boolean;
  reveal: (rowId: string | number, ready: () => void) => boolean;
};
export const VirtualRowsContext = createContext<Viewport | null>(null);

/** Share observers across rows and retain the existing scroll container. */
export function useVirtualRows(rootRef: RefObject<HTMLDivElement>, scope: string | null, enabled: boolean): Viewport {
  const rows = useMemo(() => new Map<HTMLElement, Row>(), [scope]);
  const intersection = useRef<IntersectionObserver | null>(null);
  const resize = useRef<ResizeObserver | null>(null);
  const selectionActive = useRef(false);
  const active = useRef(false);
  const viewport = useMemo<Viewport>(() => ({
    register(element, row) {
      rows.set(element, row);
      intersection.current?.observe(element);
      resize.current?.observe(element);
      return () => {
        rows.delete(element);
        intersection.current?.unobserve(element);
        resize.current?.unobserve(element);
      };
    },
    protected: () => !active.current || selectionActive.current,
    nearby(element) {
      const root = rootRef.current;
      if (!root) return true;
      const viewportRect = root.getBoundingClientRect();
      const rowRect = element.getBoundingClientRect();
      const margin = Math.max(600, root.clientHeight * 2);
      return rowRect.bottom >= viewportRect.top - margin && rowRect.top <= viewportRect.bottom + margin;
    },
    reveal(rowId, ready) {
      for (const [element, row] of rows) {
        if (element.dataset.virtualRowId === String(rowId)) {
          row.reveal(ready);
          return true;
        }
      }
      return false;
    },
  }), [rows, rootRef]);

  useLayoutEffect(() => {
    active.current = enabled;
    const root = rootRef.current;
    if (!enabled || !root) {
      for (const row of rows.values()) row.reveal();
      return;
    }
    let width = root.clientWidth;
    let height = root.clientHeight;
    const observeViewport = () => {
      intersection.current?.disconnect();
      intersection.current = new IntersectionObserver(entries => {
        for (const entry of entries) rows.get(entry.target as HTMLElement)?.visibility(entry.isIntersecting);
      }, { root, rootMargin: Math.max(600, root.clientHeight * 2) + 'px 0px' });
      for (const element of rows.keys()) intersection.current.observe(element);
    };
    observeViewport();
    resize.current = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target !== root) {
          rows.get(entry.target as HTMLElement)?.resize();
          continue;
        }
        if (root.clientWidth !== width) {
          width = root.clientWidth;
          for (const row of rows.values()) row.remeasure();
        }
        if (root.clientHeight !== height) {
          height = root.clientHeight;
          observeViewport();
        }
      }
    });
    resize.current.observe(root);
    for (const element of rows.keys()) resize.current.observe(element);
    const selectionChanged = () => {
      const selection = document.getSelection();
      const selected = Boolean(selection && !selection.isCollapsed && selection.rangeCount
        && selection.getRangeAt(0).intersectsNode(root));
      if (selected === selectionActive.current) return;
      selectionActive.current = selected;
      for (const row of rows.values()) {
        if (selected) row.reveal();
        else row.release();
      }
    };
    const refreshSizes = () => {
      for (const row of rows.values()) row.remeasure();
    };
    document.fonts.addEventListener('loadingdone', refreshSizes);
    document.addEventListener('selectionchange', selectionChanged);
    selectionChanged();
    return () => {
      active.current = false;
      selectionActive.current = false;
      document.removeEventListener('selectionchange', selectionChanged);
      document.fonts.removeEventListener('loadingdone', refreshSizes);
      intersection.current?.disconnect();
      resize.current?.disconnect();
      intersection.current = null;
      resize.current = null;
    };
  }, [enabled, rootRef, rows]);
  return viewport;
}

export type VirtualRowProps = {
  id: string | number;
  revision?: unknown;
  keepMounted?: boolean;
  className?: string;
  children: ReactNode | (() => ReactNode);
};

/** Keep a measured shell while distant row contents are unmounted. */
export function VirtualRow({ id, revision, keepMounted = false, className, children }: VirtualRowProps) {
  const viewport = useContext(VirtualRowsContext);
  const elementRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(true);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const pinned = useRef(keepMounted);
  pinned.current = keepMounted;
  const nearby = useRef(true);
  const measuredHeight = useRef(0);
  const onReady = useRef<(() => void) | undefined>();
  const frame = useRef(0);
  const row = useMemo<Row>(() => {
    const measure = () => {
      if (mountedRef.current && elementRef.current) {
        measuredHeight.current = elementRef.current.getBoundingClientRect().height;
      }
    };
    const release = () => {
      const element = elementRef.current;
      if (!element || nearby.current || pinned.current || viewport?.protected() || viewport?.nearby(element)
        || !measuredHeight.current || element.contains(document.activeElement)
        || element.querySelector(
          'details[open], [aria-expanded="true"], iframe, canvas, video, audio, input, textarea, select, '
          + '[data-message-chart], [data-message-diagram], [data-interactive-preview]',
        )) return;
      setMounted(false);
    };
    return {
      visibility(visible) {
        nearby.current = visible;
        if (visible) setMounted(true);
        else release();
      },
      reveal(ready) {
        onReady.current = ready ?? onReady.current;
        if (mountedRef.current) {
          measure();
          const callback = onReady.current;
          onReady.current = undefined;
          callback?.();
        } else setMounted(true);
      },
      remeasure: () => setMounted(true),
      release,
      resize: measure,
    };
  }, [viewport]);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !viewport) return;
    const unregister = viewport.register(element, row);
    element.addEventListener('toggle', row.release, true);
    return () => {
      element.removeEventListener('toggle', row.release, true);
      unregister();
    };
  }, [row, viewport]);
  useLayoutEffect(() => {
    // Refresh a placeholder when its source or explicit pin changes.
    if (!mountedRef.current) setMounted(true);
  }, [revision, keepMounted, row]);
  useLayoutEffect(() => {
    if (!mounted) return;
    row.resize();
    const ready = onReady.current;
    onReady.current = undefined;
    ready?.();
    frame.current = requestAnimationFrame(row.release);
    return () => cancelAnimationFrame(frame.current);
  }, [mounted, revision, keepMounted, row]);

  return <div
    ref={elementRef}
    className={className ? `${s.row} ${className}` : s.row}
    data-virtual-row-id={id}
    data-virtual-row-placeholder={!mounted || undefined}
    style={mounted ? undefined : { height: measuredHeight.current }}
    onBlurCapture={() => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(row.release);
    }}
  >{mounted ? typeof children === 'function' ? children() : children : null}</div>;
}
