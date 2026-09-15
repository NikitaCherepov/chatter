import type { NewspaperBlock, NewspaperIssue } from '../../types';
import { distributeIssueV2, type IssuePaginationRules } from '../../layout/distributeIssueV2';

const priorityLimits = { blocks: 11, mainHeaders: 1, articles: 4, images: 2, weather: 1, newsItems: 10, notes: 3 };

function isHero(block: NewspaperBlock) {
  return block.type === 'article' && block.role === 'hero';
}

function hasHero(pending: readonly NewspaperBlock[]) {
  return pending.some(isHero);
}

function availableImages(pending: readonly NewspaperBlock[]) {
  return pending.reduce((count, block) => count + (block.type === 'image' || block.type === 'article' && Boolean(block.image_url) ? 1 : 0), 0);
}

function availableNewsItems(pending: readonly NewspaperBlock[]) {
  return pending.reduce((count, block) => count + (block.type === 'notes_list' ? block.items.length : 0), 0);
}

export const DEUS_EX_PAGINATION_RULES: IssuePaginationRules = {
  recipes: [
    {
      id: 'priority-report',
      priority: 100,
      limits: priorityLimits,
      matches: hasHero,
      canPlaceBlock: (page, block) => isHero(block) || page.some(isHero) || page.length < priorityLimits.blocks - 1,
    },
    {
      id: 'media-monitor',
      priority: 70,
      limits: { blocks: 12, mainHeaders: 0, articles: 2, images: 10, weather: 0, newsItems: 4, notes: 2 },
      matches: pending => !hasHero(pending) && availableImages(pending) >= 4,
      canPlaceBlock: (_page, block) => block.type === 'image' || block.type === 'article' && Boolean(block.image_url),
    },
    {
      id: 'dispatch-feed',
      priority: 60,
      limits: { blocks: 20, mainHeaders: 0, articles: 3, images: 2, weather: 1, newsItems: 36, notes: 4 },
      matches: pending => !hasHero(pending) && availableNewsItems(pending) >= 12,
    },
    {
      id: 'intel-board',
      limits: { blocks: 12, mainHeaders: 0, articles: 5, images: 3, weather: 1, newsItems: 12, notes: 4 },
    },
  ],
};

export function distributeDeusExIssue(issue: NewspaperIssue): NewspaperIssue[] {
  return distributeIssueV2(issue, DEUS_EX_PAGINATION_RULES);
}
