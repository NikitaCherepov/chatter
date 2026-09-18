import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { NewspaperVisualStyle } from './types';
import s from './Newspaper.module.scss';

export function NewspaperFocusTransition({ snapshot, style, direction, left, top, width, height, onComplete }: {
  snapshot: HTMLCanvasElement;
  style: NewspaperVisualStyle;
  direction: 'open' | 'close';
  left: number;
  top: number;
  width: number;
  height: number;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    canvas.getContext('2d')?.drawImage(snapshot, 0, 0);
  }, [snapshot]);
  const forward = direction === 'open';
  return <div className={s.focusTransition} data-style={style} style={{ left, top, width, height }}>
    <motion.div
      className={s.focusTransitionSnapshot}
      initial={false}
      animate={{ clipPath: forward ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)' }}
      transition={{ duration: .42, ease: [0.76, 0, 0.24, 1] }}
      onAnimationComplete={onComplete}
    ><canvas ref={canvasRef}/></motion.div>
    <motion.i
      initial={{ left: forward ? '100%' : '0%' }}
      animate={{ left: forward ? '0%' : '100%' }}
      transition={{ duration: .42, ease: [0.76, 0, 0.24, 1] }}
    />
  </div>;
}
