import type { NewspaperBlock } from '../../types';

export type BroadsheetRecipe = 'lead' | 'feature-left' | 'feature-columns' | 'section-page' | 'briefs-page' | 'photo-page';

export type BroadsheetPageLayout = {
  recipe: BroadsheetRecipe;
  hero?: Extract<NewspaperBlock, { type: 'article' }>;
  articles: Extract<NewspaperBlock, { type: 'article' }>[];
  weather?: Extract<NewspaperBlock, { type: 'weather' }>;
  noteLists: Extract<NewspaperBlock, { type: 'notes_list' }>[];
  notes: Extract<NewspaperBlock, { type: 'note' }>[];
  images: Extract<NewspaperBlock, { type: 'image' }>[];
};

function stableVariant(value: string) {
  return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 2;
}

export function composeBroadsheetPage(blocks: readonly NewspaperBlock[], seed = 0): BroadsheetPageLayout {
  const articleBlocks = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'article' }> => block.type === 'article');
  const hero = articleBlocks.find(article => article.role === 'hero');
  const articles = articleBlocks.filter(article => article !== hero);
  const noteLists = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'notes_list' }> => block.type === 'notes_list');
  const notes = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'note' }> => block.type === 'note');
  const images = blocks.filter((block): block is Extract<NewspaperBlock, { type: 'image' }> => block.type === 'image');
  const weather = blocks.find((block): block is Extract<NewspaperBlock, { type: 'weather' }> => block.type === 'weather');
  const onlyImages = blocks.length > 0 && blocks.every(block => block.type === 'image');
  const onlyBriefs = blocks.length > 0 && blocks.every(block => block.type === 'notes_list');
  const recipe: BroadsheetRecipe = onlyImages
    ? 'photo-page'
    : onlyBriefs
      ? 'briefs-page'
      : hero && (weather || !hero.image_url)
        ? 'lead'
        : hero
          ? stableVariant(`${hero.id}-${seed}`) === 0 ? 'feature-left' : 'feature-columns'
          : 'section-page';
  return { recipe, hero, articles, weather, noteLists, notes, images };
}
