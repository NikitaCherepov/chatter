import type { NewspaperVisualStyle } from '../types';

export type TemplateCapacity = {
  heroArticles: number;
  supportingArticles: number;
  noteItems: number;
  images: number;
};

export const TEMPLATE_CAPACITY: Record<NewspaperVisualStyle, TemplateCapacity> = {
  wizarding: { heroArticles: 1, supportingArticles: 3, noteItems: 4, images: 1 },
  editorial: { heroArticles: 1, supportingArticles: 3, noteItems: 4, images: 1 },
  broadsheet: { heroArticles: 1, supportingArticles: 3, noteItems: 5, images: 1 },
  deusEx: { heroArticles: 1, supportingArticles: 3, noteItems: 4, images: 1 },
  massEffect: { heroArticles: 1, supportingArticles: 3, noteItems: 5, images: 1 },
};

export const MAX_NEWSPAPER_PAGES = 8;
