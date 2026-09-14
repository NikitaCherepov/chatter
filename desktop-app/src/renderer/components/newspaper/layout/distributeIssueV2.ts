import type { NewspaperBlock, NewspaperIssue, NewspaperNote } from '../types';

export type PageContentLimits = {
  blocks: number;
  mainHeaders: number;
  articles: number;
  images: number;
  weather: number;
  newsItems: number;
  notes: number;
};

export type IssuePaginationRules = {
  limits: PageContentLimits;
  canPlaceBlock?: (page: readonly NewspaperBlock[], block: NewspaperBlock) => boolean;
};

type PageStats = PageContentLimits;

const EMPTY_STATS: PageStats = {
  blocks: 0,
  mainHeaders: 0,
  articles: 0,
  images: 0,
  weather: 0,
  newsItems: 0,
  notes: 0,
};

function getStats(blocks: readonly NewspaperBlock[]): PageStats {
  return blocks.reduce<PageStats>((stats, block) => {
    stats.blocks += 1;
    if (block.type === 'article') {
      block.role === 'hero' ? stats.mainHeaders += 1 : stats.articles += 1;
    } else if (block.type === 'image') {
      stats.images += 1;
    } else if (block.type === 'weather') {
      stats.weather += 1;
    } else if (block.type === 'notes_list') {
      stats.newsItems += block.items.length;
    } else if (block.type === 'note') {
      stats.notes += 1;
    }
    return stats;
  }, { ...EMPTY_STATS });
}

function isWithinLimits(stats: PageStats, limits: PageContentLimits) {
  return stats.blocks <= limits.blocks
    && stats.mainHeaders <= limits.mainHeaders
    && stats.articles <= limits.articles
    && stats.images <= limits.images
    && stats.weather <= limits.weather
    && stats.newsItems <= limits.newsItems
    && stats.notes <= limits.notes;
}

function createPage(issue: NewspaperIssue, blocks: NewspaperBlock[], index: number): NewspaperIssue {
  return {
    ...issue,
    id: issue.id * 100 - index,
    subtitle: index === 0 ? issue.subtitle : `${issue.subtitle} · Продолжение`,
    blocks_count: blocks.length,
    document: {
      ...issue.document,
      subtitle: index === 0
        ? issue.document.subtitle
        : `${issue.document.subtitle || issue.subtitle} · Страница ${index + 1}`,
      blocks,
    },
  };
}

function continuedList(
  block: Extract<NewspaperBlock, { type: 'notes_list' }>,
  items: NewspaperNote[],
): NewspaperBlock {
  const continuedTitle = block.title?.endsWith(' · Продолжение')
    ? block.title
    : `${block.title || 'Новости'} · Продолжение`;
  return {
    ...block,
    id: `${block.id}-continuation`,
    title: continuedTitle,
    items,
  };
}

/**
 * Fills pages from an editor-ordered flat array using stable deferral.
 *
 * A rejected block does not close the page: it is appended to `deferred`, and
 * later blocks still get a chance to occupy compatible slots. The deferred
 * queue retains its original order and becomes `pending` for the next page.
 */
export function distributeIssueV2(issue: NewspaperIssue, rules: IssuePaginationRules): NewspaperIssue[] {
  const pages: NewspaperBlock[][] = [];
  let pending = issue.document.blocks.map(block => ({ ...block }));

  while (pending.length > 0) {
    const page: NewspaperBlock[] = [];
    const deferred: NewspaperBlock[] = [];

    for (const block of pending) {
      const allowed = rules.canPlaceBlock?.(page, block) ?? true;
      if (!allowed) {
        deferred.push(block);
        continue;
      }

      if (block.type === 'notes_list') {
        const stats = getStats(page);
        const hasBlockSlot = stats.blocks < rules.limits.blocks;
        const availableItems = rules.limits.newsItems - stats.newsItems;
        if (!hasBlockSlot || availableItems <= 0) {
          deferred.push(block);
          continue;
        }

        const placedItems = block.items.slice(0, availableItems);
        const remainingItems = block.items.slice(placedItems.length);
        const candidate: NewspaperBlock = { ...block, items: placedItems };
        if (!isWithinLimits(getStats([...page, candidate]), rules.limits)) {
          deferred.push(block);
          continue;
        }

        page.push(candidate);
        if (remainingItems.length > 0) deferred.push(continuedList(block, remainingItems));
        continue;
      }

      const candidate = [...page, block];
      if (isWithinLimits(getStats(candidate), rules.limits)) page.push(block);
      else deferred.push(block);
    }

    // A malformed future profile must not create an endless loop or lose data.
    if (page.length === 0) {
      const [first, ...rest] = pending;
      page.push(first);
      pending = rest;
    } else {
      pending = deferred;
    }
    pages.push(page);
  }

  if (pages.length === 0) return [issue];
  return pages.map((blocks, index) => createPage(issue, blocks, index));
}
