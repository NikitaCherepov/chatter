import type { NewspaperBlock, NewspaperIssue } from '../types';
import { DEMO_WIZARDING_ISSUE } from './wizardingDemo';

const reusableImages = DEMO_WIZARDING_ISSUE.document.blocks.filter(
  (block): block is Extract<NewspaperBlock, { type: 'image' }> => block.type === 'image',
);

const mediaMonitorImages: NewspaperBlock[] = Array.from({ length: 8 }, (_, index) => {
  const source = reusableImages[index % reusableImages.length];
  return {
    ...source,
    id: `${source.id}-deus-monitor-${index + 1}`,
    title: `${source.title} · Сигнал ${String(index + 1).padStart(2, '0')}`,
  };
});

const deusExBlocks = [...DEMO_WIZARDING_ISSUE.document.blocks, ...mediaMonitorImages];

export const DEMO_DEUS_EX_ISSUE: NewspaperIssue = {
  ...DEMO_WIZARDING_ISSUE,
  blocks_count: deusExBlocks.length,
  document: {
    ...DEMO_WIZARDING_ISSUE.document,
    blocks: deusExBlocks,
  },
};
