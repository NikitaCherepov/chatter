import { useLayoutEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { NewspaperVisualStyle } from './types';
import s from './Newspaper.module.scss';

export function NewspaperFocusTransition({ snapshot, style, direction, left, top, width, height, running, onComplete }: {
  snapshot: HTMLCanvasElement;
  style: NewspaperVisualStyle;
  direction: 'open' | 'close';
  left: number;
  top: number;
  width: number;
  height: number;
  running: boolean;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    canvas.getContext('2d')?.drawImage(snapshot, 0, 0);
  }, [snapshot]);
  const forward = direction === 'open';
  const startInset = 'inset(0 0 0 0)';
  const endInset = forward ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)';
  const startLine = forward ? '100%' : '0%';
  const endLine = forward ? '0%' : '100%';
  return <div className={s.focusTransition} data-style={style} style={{ left, top, width, height }}>
    <motion.div
      className={s.focusTransitionSnapshot}
      initial={false}
      animate={{ clipPath: running ? endInset : startInset }}
      transition={{ duration: .42, ease: [0.76, 0, 0.24, 1] }}
      onAnimationComplete={() => { if (running) onComplete(); }}
    ><canvas ref={canvasRef}/></motion.div>
    <motion.i
      initial={false}
      animate={{ left: running ? endLine : startLine }}
      transition={{ duration: .42, ease: [0.76, 0, 0.24, 1] }}
    />
  </div>;
}
