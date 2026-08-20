'use client';

import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import styles from './ModelsPage.module.css';

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
  const [settled, setSettled] = useState(false);

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
            onAnimationStart={() => setSettled(false)}
            onAnimationComplete={() => setSettled(true)}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </details>
  );
}
