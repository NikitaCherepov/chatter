import type { NewspaperBlock, NewspaperIssue } from '../../types';
import { distributeIssueV2, type IssuePaginationRules } from '../../layout/distributeIssueV2';

const broadcastLimits = { blocks: 12, mainHeaders: 1, articles: 4, images: 2, weather: 1, newsItems: 10, notes: 3 };

function isHero(block: NewspaperBlock) {
  return block.type === 'article' && block.role === 'hero';
}

function mediaCount(pending: readonly NewspaperBlock[]) {
  return pending.reduce((count, block) => count + (block.type === 'image' || block.type === 'article' && Boolean(block.image_url) ? 1 : 0), 0);
}

function briefingCount(pending: readonly NewspaperBlock[]) {
  return pending.reduce((count, block) => count + (block.type === 'notes_list' ? block.items.length : 0), 0);
}

export const MASS_EFFECT_PAGINATION_RULES: IssuePaginationRules = {
  recipes: [
    {
      id: 'priority-broadcast',
      priority: 100,
      limits: broadcastLimits,
      matches: pending => pending.some(isHero),
      canPlaceBlock: (page, block) => isHero(block) || page.some(isHero) || page.length < broadcastLimits.blocks - 1,
    },
    {
      id: 'visual-relay',
      priority: 70,
      limits: { blocks: 12, mainHeaders: 0, articles: 3, images: 10, weather: 0, newsItems: 4, notes: 2 },
      matches: pending => !pending.some(isHero) && mediaCount(pending) >= 4,
      canPlaceBlock: (_page, block) => block.type === 'image' || block.type === 'article' && Boolean(block.image_url),
    },
    {
      id: 'briefing-stream',
      priority: 60,
      limits: { blocks: 18, mainHeaders: 0, articles: 3, images: 2, weather: 1, newsItems: 36, notes: 4 },
      matches: pending => !pending.some(isHero) && briefingCount(pending) >= 6,
    },
    {
      id: 'operations-grid',
      limits: { blocks: 12, mainHeaders: 0, articles: 5, images: 3, weather: 1, newsItems: 12, notes: 4 },
    },
  ],
};

export function distributeMassEffectIssue(issue: NewspaperIssue): NewspaperIssue[] {
  return distributeIssueV2(issue, MASS_EFFECT_PAGINATION_RULES);
}
