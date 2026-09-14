import type { ArticleBlockData, NewspaperBlock, NewspaperIssue, NewspaperNote, NewspaperVisualStyle } from '../types';
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

function noteAsHero(note: NewspaperNote, fallbackTitle: string): ArticleBlockData {
  return {
    id: `hero-${note.id || fallbackTitle}`,
    type: 'article',
    role: 'hero',
    title: note.title || fallbackTitle,
    text: note.text || '',
    image_url: note.image_url,
    sources: note.url ? [{ title: note.title || fallbackTitle, url: note.url }] : undefined,
  };
}

function ensurePageHero(blocks: NewspaperBlock[], fallbackTitle: string) {
  if (blocks.some(block => block.type === 'article' && block.role === 'hero')) return;

  const articleIndex = blocks.findIndex(block => block.type === 'article');
  if (articleIndex >= 0) {
    blocks[articleIndex] = { ...(blocks[articleIndex] as ArticleBlockData), role: 'hero' };
    return;
  }

  const noteIndex = blocks.findIndex(block => block.type === 'note');
  if (noteIndex >= 0) {
    const note = blocks[noteIndex];
    if (note.type === 'note') blocks[noteIndex] = noteAsHero(note, fallbackTitle);
    return;
  }

  const listIndex = blocks.findIndex(block => block.type === 'notes_list' && block.items.length);
  if (listIndex >= 0) {
    const list = blocks[listIndex];
    if (list.type !== 'notes_list') return;
    const [first, ...rest] = list.items;
    blocks.splice(listIndex, 1, noteAsHero(first, list.title || fallbackTitle), ...(rest.length ? [{ ...list, items: rest }] : []));
    return;
  }

  const imageIndex = blocks.findIndex(block => block.type === 'image');
  if (imageIndex >= 0) {
    const image = blocks[imageIndex];
    if (image.type === 'image') blocks[imageIndex] = { id: `hero-${image.id}`, type: 'article', role: 'hero', title: image.title, text: image.caption || '', image_url: image.image_url, sources: image.sources };
  }
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
    ensurePageHero(blocks, issue.document.title);
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
