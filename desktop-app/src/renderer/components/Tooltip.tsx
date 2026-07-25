import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import s from './Tooltip.module.scss';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  delayDuration?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  delayDuration = 600,
  side = 'top',
  align = 'center',
  sideOffset = 6
}) => (
  <RadixTooltip.Provider delayDuration={delayDuration}>
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={s.content}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
        >
          {content}
          <RadixTooltip.Arrow className={s.arrow} width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  </RadixTooltip.Provider>
);

export default Tooltip;
