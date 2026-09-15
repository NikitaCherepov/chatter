import type { NewspaperBlock, NewspaperIssue } from '../types';
import { DEMO_WIZARDING_ISSUE } from './wizardingDemo';

const imageSources = DEMO_WIZARDING_ISSUE.document.blocks.filter(
  (block): block is Extract<NewspaperBlock, { type: 'image' }> => block.type === 'image',
);

const relayImages: NewspaperBlock[] = Array.from({ length: 8 }, (_, index) => {
  const source = imageSources[index % imageSources.length];
  return {
    ...source,
    id: `${source.id}-ann-relay-${index + 1}`,
    title: `${source.title} · Канал ${String(index + 1).padStart(2, '0')}`,
  };
});

const massEffectBlocks = [...DEMO_WIZARDING_ISSUE.document.blocks, ...relayImages];

export const DEMO_MASS_EFFECT_ISSUE: NewspaperIssue = {
  ...DEMO_WIZARDING_ISSUE,
  blocks_count: massEffectBlocks.length,
  document: { ...DEMO_WIZARDING_ISSUE.document, blocks: massEffectBlocks },
};
