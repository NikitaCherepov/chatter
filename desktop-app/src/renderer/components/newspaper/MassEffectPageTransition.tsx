import { AnimatePresence, motion } from 'framer-motion';
import { NewspaperImageViewerProvider } from './NewspaperImageViewerContext';
import { NewspaperMaterialProvider } from './NewspaperMaterialContext';
import { TemplateRenderer } from './templates/TemplateRenderer';
import type { NewspaperIssue } from './types';
import s from './Newspaper.module.scss';

export type MassEffectPageTransitionState = {
  direction: 'previous' | 'next';
  phase: 'waiting' | 'reveal';
  sourcePageNumber: number;
  outgoingIssue: NewspaperIssue;
  scrollLeft: number;
  scrollTop: number;
};

export function MassEffectPageTransition({ transition, zoom, onComplete }: {
  transition: MassEffectPageTransitionState | null;
  zoom: number;
  onComplete: () => void;
}) {
  return <>
    <AnimatePresence>{transition && <motion.div
      key={`mass-effect-outgoing-${transition.outgoingIssue.id}`}
      className={s.massEffectOutgoingPage}
      style={{
        zoom: zoom / 100,
        left: -transition.scrollLeft / (zoom / 100),
        top: -transition.scrollTop / (zoom / 100),
        height: `calc(100% + ${transition.scrollTop / (zoom / 100)}px)`,
      } as React.CSSProperties}
      initial={false}
      animate={{ clipPath: transition.phase === 'reveal'
        ? (transition.direction === 'next' ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)')
        : 'inset(0 0 0 0)' }}
      transition={{ duration: transition.phase === 'reveal' ? .48 : 0, ease: [0.76, 0, 0.24, 1] }}
      onAnimationComplete={() => {
        if (transition.phase === 'reveal') onComplete();
      }}
    ><NewspaperImageViewerProvider onOpen={() => undefined}><NewspaperMaterialProvider onOpen={() => undefined}><TemplateRenderer issue={transition.outgoingIssue} style="massEffect"/></NewspaperMaterialProvider></NewspaperImageViewerProvider></motion.div>}</AnimatePresence>
    <AnimatePresence>{transition?.phase === 'reveal' && <motion.div
      key="mass-effect-divider"
      className={s.massEffectDividerLayer}
      style={{ zoom: zoom / 100 } as React.CSSProperties}
      initial={false}
    ><motion.i
      initial={{ left: transition.direction === 'next' ? '100%' : '0%' }}
      animate={{ left: transition.direction === 'next' ? '0%' : '100%' }}
      transition={{ duration: .48, ease: [0.76, 0, 0.24, 1] }}
    /></motion.div>}</AnimatePresence>
  </>;
}
