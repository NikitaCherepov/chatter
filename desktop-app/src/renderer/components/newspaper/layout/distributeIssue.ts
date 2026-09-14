import type { NewspaperBlock, NewspaperIssue, NewspaperVisualStyle } from '../types';
import { MAX_NEWSPAPER_PAGES, TEMPLATE_CAPACITY } from './templateCapacity';

type PageStats = { heroes: number; articles: number; notes: number; images: number };

function getStats(blocks: NewspaperBlock[]): PageStats {
  return blocks.reduce<PageStats>((stats, block) => {
    if (block.type === 'article') block.role === 'hero' ? stats.heroes++ : stats.articles++;
    if (block.type === 'note') stats.notes++;
    if (block.type === 'notes_list') stats.notes += block.items.length;
    if (block.type === 'image') stats.images++;
    return stats;
  }, { heroes: 0, articles: 0, notes: 0, images: 0 });
}

export function distributeIssue(issue: NewspaperIssue, style: NewspaperVisualStyle): NewspaperIssue[] {
  const capacity = TEMPLATE_CAPACITY[style];
  const weather = issue.document.blocks.find(block => block.type === 'weather');
  const sourceBlocks = issue.document.blocks.filter(block => block.type !== 'weather');
  const pageBlocks: NewspaperBlock[][] = [[]];
  const findPage = (fits: (stats: PageStats) => boolean) => {
    const existing = pageBlocks.findIndex(blocks => fits(getStats(blocks)));
    if (existing >= 0) return existing;
    if (pageBlocks.length < MAX_NEWSPAPER_PAGES) {
      pageBlocks.push([]);
      return pageBlocks.length - 1;
    }
    return pageBlocks.length - 1;
  };

  for (const block of sourceBlocks) {
    if (block.type === 'notes_list') {
      let offset = 0;
      while (offset < block.items.length) {
        const target = findPage(stats => stats.notes < capacity.noteItems);
        const available = target === MAX_NEWSPAPER_PAGES - 1 && pageBlocks.length === MAX_NEWSPAPER_PAGES
          ? Math.max(capacity.noteItems - getStats(pageBlocks[target]).notes, block.items.length - offset)
          : capacity.noteItems - getStats(pageBlocks[target]).notes;
        const items = block.items.slice(offset, offset + available);
        pageBlocks[target].push({ ...block, id: `${block.id}-page-${target + 1}`, items });
        offset += items.length;
      }
      continue;
    }

    const target = findPage(stats => block.type === 'article'
      ? (block.role === 'hero' ? stats.heroes < capacity.heroArticles : stats.articles < capacity.supportingArticles)
      : block.type === 'note'
        ? stats.notes < capacity.noteItems
        : block.type === 'image'
          ? stats.images < capacity.images
          : true);
    pageBlocks[target].push({ ...block });
  }

  const nonEmptyPages = pageBlocks.filter(blocks => blocks.length);
  if (!nonEmptyPages.length) return [issue];

  return nonEmptyPages.map((blocks, index) => {
    const renderedBlocks = weather ? [{ ...weather, id: `${weather.id}-page-${index + 1}` }, ...blocks] : blocks;
    return {
      ...issue,
      id: issue.id * 100 - index,
      subtitle: index ? `${issue.subtitle} · Продолжение` : issue.subtitle,
      blocks_count: renderedBlocks.length,
      document: {
        ...issue.document,
        subtitle: index ? `${issue.document.subtitle || issue.subtitle} · Страница ${index + 1}` : issue.document.subtitle,
        blocks: renderedBlocks,
      },
    };
  });
}
