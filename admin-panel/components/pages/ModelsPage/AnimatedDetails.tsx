'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import styles from './ModelsPage.module.css';

const ANIMATION_MS = 220;

export function AnimatedDetails({
  open,
  onToggle,
  className,
  summary,
  children,
}: {
  open: boolean;
  onToggle: (nextOpen: boolean) => void;
  className: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  // overflow must clip ONLY while the height animates — otherwise absolutely
  // positioned dropdowns (Select) inside the body get cut off.
  // A timer (not animation callbacks) is used because cards mounted already
  // open (persisted state) skip the enter animation entirely, so
  // onAnimationComplete never fires for them.
  const [settled, setSettled] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) setSettled(false);
    wasOpenRef.current = open;
    if (!open) return;
    const timer = window.setTimeout(() => setSettled(true), ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <details open className={`${className} ${open ? styles.detailsOpen : ''}`}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          onToggle(!open);
        }}
      >
        {summary}
      </summary>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ overflow: settled && open ? 'visible' : 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </details>
  );
}
