import type { NewspaperBlock } from '../../types';

export type MassEffectRecipe = 'priority-broadcast' | 'operations-grid' | 'briefing-stream' | 'visual-relay';

export function composeMassEffectPage(blocks: readonly NewspaperBlock[]) {
  const articles = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'article' }> => block.type === 'article');
  const hero = articles.find(article => article.role === 'hero');
  const supportingArticles = articles.filter(article => article !== hero);
  const images = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'image' }> => block.type === 'image');
  const noteLists = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'notes_list' }> => block.type === 'notes_list');
  const notes = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'note' }> => block.type === 'note');
  const weather = blocks.find((block): block is Extract<NewspaperBlock, { type: 'weather' }> => block.type === 'weather');
  const newsItems = noteLists.reduce((count, list) => count + list.items.length, 0);
  const onlyMedia = blocks.length > 0 && blocks.every(block => block.type === 'image' || block.type === 'article' && Boolean(block.image_url));
  const recipe: MassEffectRecipe = hero
    ? 'priority-broadcast'
    : onlyMedia && images.length >= 4
      ? 'visual-relay'
      : newsItems >= 6
        ? 'briefing-stream'
        : 'operations-grid';

  return { recipe, hero, articles: supportingArticles, images, noteLists, notes, weather };
}
