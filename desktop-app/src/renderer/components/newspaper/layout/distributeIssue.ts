import type { ArticleBlockData, HeroBlockData, ImageBlockData, NewspaperBlock, NewspaperIssue, NewspaperVisualStyle, NewsListBlockData } from '../types';
import { MAX_NEWSPAPER_PAGES, TEMPLATE_CAPACITY } from './templateCapacity';

const byPriority = <T extends NewspaperBlock>(blocks: T[]) => blocks
  .map((block, index) => ({ block, index }))
  .sort((a, b) => (b.block.priority ?? 0) - (a.block.priority ?? 0) || a.index - b.index)
  .map(({ block }) => block);

function promoteToHero(article?: ArticleBlockData, news?: NewsListBlockData['items'][number], image?: ImageBlockData): HeroBlockData | undefined {
  if (article) return { ...article, type: 'hero' };
  if (news) return { id: `lead-${news.title}`, type: 'hero', title: news.title, summary: news.summary || '', sources: news.url ? [{ title: news.title, url: news.url }] : undefined };
  if (image) return { id: `lead-${image.id}`, type: 'hero', title: image.title, summary: image.caption || '', image_url: image.image_url, sources: image.sources };
  return undefined;
}

export function distributeIssue(issue: NewspaperIssue, style: NewspaperVisualStyle): NewspaperIssue[] {
  const capacity = TEMPLATE_CAPACITY[style];
  const weather = byPriority(issue.document.blocks.filter(block => block.type === 'weather'))[0];
  const heroes = byPriority(issue.document.blocks.filter(block => block.type === 'hero'));
  const articles = byPriority(issue.document.blocks.filter(block => block.type === 'article'));
  const images = byPriority(issue.document.blocks.filter(block => block.type === 'image'));
  const humors = byPriority(issue.document.blocks.filter(block => block.type === 'humor'));
  const newsBlocks = byPriority(issue.document.blocks.filter(block => block.type === 'news_list'));
  const newsItems = newsBlocks.flatMap(block => block.items.map(item => ({ item, title: block.title, priority: block.priority })));
  const pages: NewspaperIssue[] = [];

  const hasContent = () => heroes.length || articles.length || images.length || humors.length || newsItems.length;
  while (hasContent() && pages.length < MAX_NEWSPAPER_PAGES) {
    const pageIndex = pages.length;
    const promotedArticle = heroes.length ? undefined : articles.shift();
    const promotedNews = heroes.length || promotedArticle ? undefined : newsItems.shift()?.item;
    const promotedImage = heroes.length || promotedArticle || promotedNews ? undefined : images.shift();
    const hero = heroes.shift() || promoteToHero(promotedArticle, promotedNews, promotedImage);
    const pageNews = newsItems.splice(0, capacity.newsItems);
    const pageArticles = articles.splice(0, capacity.articles);
    const pageImages = images.splice(0, capacity.images);
    const humor = humors.shift();
    const blocks: NewspaperBlock[] = [];

    if (weather) blocks.push({ ...weather, id: `${weather.id}-page-${pageIndex + 1}` });
    if (hero) blocks.push(hero);
    if (pageNews.length) blocks.push({
      id: `news-page-${pageIndex + 1}`,
      type: 'news_list',
      title: pageNews[0].title,
      priority: Math.max(...pageNews.map(entry => entry.priority ?? 0)),
      items: pageNews.map(entry => entry.item),
    });
    blocks.push(...pageArticles, ...pageImages);
    if (humor) blocks.push(humor);

    pages.push({
      ...issue,
      id: issue.id * 100 - pageIndex,
      subtitle: pageIndex ? `${issue.subtitle} · Продолжение` : issue.subtitle,
      blocks_count: blocks.length,
      document: {
        ...issue.document,
        subtitle: pageIndex ? `${issue.document.subtitle || issue.subtitle} · Страница ${pageIndex + 1}` : issue.document.subtitle,
        blocks,
      },
    });
  }

  if (!pages.length) return [issue];

  // A malformed model response must not create an unbounded reader. Preserve any
  // overflow on the last page instead of silently discarding it.
  if (hasContent()) {
    const last = pages[pages.length - 1];
    const overflowNews = newsItems.splice(0);
    const overflow: NewspaperBlock[] = [
      ...heroes.map(hero => ({ ...hero, type: 'article' as const })),
      ...articles,
      ...images,
      ...humors.map(humor => ({ ...humor, type: 'article' as const, summary: humor.text })),
    ];
    if (overflowNews.length) overflow.unshift({ id: 'news-overflow', type: 'news_list', title: overflowNews[0].title, items: overflowNews.map(entry => entry.item) });
    last.document.blocks.push(...overflow);
    last.blocks_count = last.document.blocks.length;
  }

  return pages;
}
