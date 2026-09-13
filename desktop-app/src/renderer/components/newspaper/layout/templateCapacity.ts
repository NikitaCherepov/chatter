import type { NewspaperVisualStyle } from '../types';

export type TemplateCapacity = {
  newsItems: number;
  articles: number;
  images: number;
};

export const TEMPLATE_CAPACITY: Record<NewspaperVisualStyle, TemplateCapacity> = {
  wizarding: { newsItems: 3, articles: 3, images: 1 },
  editorial: { newsItems: 3, articles: 3, images: 1 },
  broadsheet: { newsItems: 4, articles: 3, images: 1 },
  deusEx: { newsItems: 3, articles: 3, images: 1 },
  massEffect: { newsItems: 4, articles: 3, images: 1 },
};

export const MAX_NEWSPAPER_PAGES = 8;
