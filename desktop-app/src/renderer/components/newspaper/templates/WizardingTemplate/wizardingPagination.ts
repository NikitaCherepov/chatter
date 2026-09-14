import type { NewspaperBlock, NewspaperIssue } from '../../types';
import { distributeIssueV2, type IssuePaginationRules } from '../../layout/distributeIssueV2';

const standardLimits = {
  blocks: 6,
  mainHeaders: 1,
  articles: 4,
  images: 2,
  weather: 1,
  newsItems: 10,
  notes: 4,
};

function isHero(block: NewspaperBlock) {
  return block.type === 'article' && block.role === 'hero';
}

function leadingNewsItems(pending: readonly NewspaperBlock[]) {
  let count = 0;
  for (const block of pending) {
    if (block.type !== 'notes_list') break;
    count += block.items.length;
  }
  return count;
}

function leadingImages(pending: readonly NewspaperBlock[]) {
  let count = 0;
  for (const block of pending) {
    if (block.type !== 'image') break;
    count += 1;
  }
  return count;
}

export const WIZARDING_PAGINATION_RULES: IssuePaginationRules = {
  recipes: [
    {
      id: 'hero',
      priority: 100,
      limits: standardLimits,
      matches: pending => pending.some(isHero),
      // Keep one physical slot open until the highest-priority hero is met.
      canPlaceBlock: (page, block) => isHero(block)
        || page.some(isHero)
        || page.length < standardLimits.blocks - 1,
    },
    {
      id: 'image-page',
      priority: 20,
      limits: {
        blocks: 6,
        mainHeaders: 0,
        articles: 0,
        images: 6,
        weather: 0,
        newsItems: 0,
        notes: 0,
      },
      matches: pending => pending.every(block => block.type === 'image') || leadingImages(pending) >= 3,
      canPlaceBlock: (_page, block) => block.type === 'image',
    },
    {
      id: 'notes-page',
      priority: 10,
      limits: {
        blocks: 4,
        mainHeaders: 0,
        articles: 0,
        images: 0,
        weather: 0,
        newsItems: 18,
        notes: 0,
      },
      matches: pending => pending.every(block => block.type === 'notes_list') || leadingNewsItems(pending) >= 10,
      canPlaceBlock: (_page, block) => block.type === 'notes_list',
    },
    {
      id: 'mosaic',
      limits: standardLimits,
    },
  ],
};

export function distributeWizardingIssue(issue: NewspaperIssue): NewspaperIssue[] {
  return distributeIssueV2(issue, WIZARDING_PAGINATION_RULES);
}
