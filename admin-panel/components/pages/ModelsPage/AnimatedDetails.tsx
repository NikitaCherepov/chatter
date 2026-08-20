'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import styles from './ModelsPage.module.css';

/**
 * `<details>` with an animated expand/collapse (framer-motion).
 *
 * The native `open` attribute is intentionally NOT used: removing it makes
 * the browser hide all non-summary children instantly, which would cut the
 * exit animation. Instead the body is rendered conditionally inside an
 * AnimatePresence height animation, and the visual "open" state is exposed
 * to CSS via the `.detailsOpen` class (chevron rotation, +/− marker, …).
 */
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
  return (
    <details open className={`${className} ${open ? styles.detailsOpen : ''}`}>
      <summary
        onClick={(event) => {
          // Prevent the instant native toggle; we animate instead.
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
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </details>
  );
}
