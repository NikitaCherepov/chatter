import type { NewspaperBlock, NewspaperPageContent } from '../types';

export function pageContent(blocks: NewspaperBlock[]): NewspaperPageContent {
  return {
    weather: blocks.find(block => block.type === 'weather') as NewspaperPageContent['weather'],
    hero: blocks.find(block => block.type === 'hero') as NewspaperPageContent['hero'],
    news: blocks.find(block => block.type === 'news_list') as NewspaperPageContent['news'],
    articles: blocks.filter(block => block.type === 'article') as NewspaperPageContent['articles'],
    images: blocks.filter(block => block.type === 'image') as NewspaperPageContent['images'],
    humor: blocks.find(block => block.type === 'humor') as NewspaperPageContent['humor'],
  };
}
