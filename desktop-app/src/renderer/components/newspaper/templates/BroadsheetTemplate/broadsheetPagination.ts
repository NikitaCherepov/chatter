import type { NewspaperBlock, NewspaperIssue } from '../../types';
import { distributeIssueV2, type IssuePaginationRules } from '../../layout/distributeIssueV2';

const standardLimits = { blocks: 9, mainHeaders: 1, articles: 4, images: 0, weather: 1, newsItems: 10, notes: 3 };

function isHero(block: NewspaperBlock) {
  return block.type === 'article' && block.role === 'hero';
}

function leadingImages(pending: readonly NewspaperBlock[]) {
  let count = 0;
  for (const block of pending) {
    if (block.type !== 'image') break;
    count += 1;
  }
  return count;
}

function leadingNewsItems(pending: readonly NewspaperBlock[]) {
  let count = 0;
  for (const block of pending) {
    if (block.type !== 'notes_list') break;
    count += block.items.length;
  }
  return count;
}

export const BROADSHEET_PAGINATION_RULES: IssuePaginationRules = {
  recipes: [
    {
      id: 'lead',
      priority: 100,
      limits: standardLimits,
      matches: pending => pending.some(isHero),
      canPlaceBlock: (page, block) => isHero(block) || page.some(isHero) || page.length < standardLimits.blocks - 1,
    },
    {
      id: 'photo-page',
      priority: 30,
      limits: { blocks: 10, mainHeaders: 0, articles: 0, images: 10, weather: 0, newsItems: 0, notes: 0 },
      matches: pending => pending.every(block => block.type === 'image') || leadingImages(pending) >= 4,
      canPlaceBlock: (_page, block) => block.type === 'image',
    },
    {
      id: 'briefs-page',
      priority: 20,
      limits: { blocks: 5, mainHeaders: 0, articles: 0, images: 0, weather: 0, newsItems: 24, notes: 0 },
      matches: pending => pending.every(block => block.type === 'notes_list') || leadingNewsItems(pending) >= 12,
      canPlaceBlock: (_page, block) => block.type === 'notes_list',
    },
    {
      id: 'section-page',
      limits: { ...standardLimits, mainHeaders: 0, blocks: 10, articles: 5, newsItems: 12 },
    },
  ],
};

export function distributeBroadsheetIssue(issue: NewspaperIssue): NewspaperIssue[] {
  return distributeIssueV2(issue, BROADSHEET_PAGINATION_RULES);
}
