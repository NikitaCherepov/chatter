import type { NewspaperBlock, NewspaperPageContent } from '../types';

export function pageContent(blocks: NewspaperBlock[]): NewspaperPageContent {
  const articles = blocks.filter(block => block.type === 'article');
  return {
    weather: blocks.find(block => block.type === 'weather') as NewspaperPageContent['weather'],
    hero: articles.find(article => article.role === 'hero'),
    articles: articles.filter(article => article.role !== 'hero'),
    notes: blocks.filter(block => block.type === 'note'),
    noteLists: blocks.filter(block => block.type === 'notes_list'),
    images: blocks.filter(block => block.type === 'image') as NewspaperPageContent['images'],
  };
}
