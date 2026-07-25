import React, { useCallback, useRef } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import s from './Tooltip.module.scss';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  delayDuration?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  arrowAtPointer?: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  delayDuration = 600,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  arrowAtPointer = false
}) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pointerXRef = useRef<number | null>(null);

  const updateArrowPosition = useCallback((clientX = pointerXRef.current) => {
    if (!arrowAtPointer || clientX == null || !contentRef.current) return;

    const rect = contentRef.current.getBoundingClientRect();
    const edgePadding = 10;
    const arrowLeft = Math.max(edgePadding, Math.min(rect.width - edgePadding, clientX - rect.left));

    contentRef.current.style.setProperty('--tooltip-arrow-left', `${arrowLeft}px`);
  }, [arrowAtPointer]);

  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (node && pointerXRef.current != null) {
      requestAnimationFrame(() => updateArrowPosition());
    }
  }, [updateArrowPosition]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (contentRef.current) return;

    pointerXRef.current = event.clientX;
  }, []);

  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger
          asChild
          onPointerMove={arrowAtPointer ? handlePointerMove : undefined}
        >
          {children}
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className={`${s.content} ${arrowAtPointer ? s.pointerArrow : ''}`}
            ref={setContentRef}
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={8}
          >
            {content}
            {!arrowAtPointer && (
              <RadixTooltip.Arrow className={s.arrow} width={8} height={4} />
            )}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
};

export default Tooltip;
