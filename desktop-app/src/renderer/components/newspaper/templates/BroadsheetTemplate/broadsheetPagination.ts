import type { NewspaperBlock, NewspaperIssue } from '../../types';
import { distributeIssueV2, type IssuePaginationRules } from '../../layout/distributeIssueV2';

const standardLimits = { blocks: 9, mainHeaders: 1, articles: 4, images: 0, weather: 1, newsItems: 10, notes: 3 };
const featureLimits = { blocks: 10, mainHeaders: 1, articles: 2, images: 1, weather: 0, newsItems: 12, notes: 2 };

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

function availableNewsItems(pending: readonly NewspaperBlock[]) {
  return pending.reduce((count, block) => count + (block.type === 'notes_list' ? block.items.length : 0), 0);
}

function nextHero(pending: readonly NewspaperBlock[]) {
  return pending.find((block): block is Extract<NewspaperBlock, { type: 'article' }> => isHero(block));
}

function hasWeatherBeforeNextHero(pending: readonly NewspaperBlock[]) {
  const heroIndex = pending.findIndex(isHero);
  return heroIndex >= 0 && pending.slice(0, heroIndex).some(block => block.type === 'weather');
}

export const BROADSHEET_PAGINATION_RULES: IssuePaginationRules = {
  recipes: [
    {
      id: 'front-page',
      priority: 120,
      limits: standardLimits,
      matches: pending => hasWeatherBeforeNextHero(pending),
      canPlaceBlock: (page, block) => isHero(block) || page.some(isHero) || page.length < standardLimits.blocks - 1,
    },
    {
      id: 'text-lead',
      priority: 110,
      limits: standardLimits,
      matches: pending => {
        const hero = nextHero(pending);
        return Boolean(hero && !hero.image_url);
      },
      canPlaceBlock: (page, block) => isHero(block) || page.some(isHero) || page.length < standardLimits.blocks - 1,
    },
    {
      id: 'inside-feature',
      priority: 100,
      limits: featureLimits,
      matches: pending => Boolean(nextHero(pending)),
      canPlaceBlock: (_page, block) => block.type !== 'weather',
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
      limits: { blocks: 64, mainHeaders: 0, articles: 0, images: 0, weather: 0, newsItems: 96, notes: 0 },
      matches: pending => pending.every(block => block.type === 'notes_list') || availableNewsItems(pending) >= 12,
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
