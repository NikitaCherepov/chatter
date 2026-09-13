import type { NewspaperBlock, NewspaperIssue, NewspaperSource } from '../../lib/api';

export type NewspaperVisualStyle = 'wizarding' | 'editorial' | 'broadsheet' | 'deusEx' | 'massEffect';
export type WeatherBlockData = Extract<NewspaperBlock, { type: 'weather' }>;
export type HeroBlockData = Extract<NewspaperBlock, { type: 'hero' }>;
export type ArticleBlockData = Extract<NewspaperBlock, { type: 'article' }>;
export type NewsListBlockData = Extract<NewspaperBlock, { type: 'news_list' }>;
export type ImageBlockData = Extract<NewspaperBlock, { type: 'image' }>;
export type HumorBlockData = Extract<NewspaperBlock, { type: 'humor' }>;

export type NewspaperPageContent = {
  weather?: WeatherBlockData;
  hero?: HeroBlockData;
  news?: NewsListBlockData;
  articles: ArticleBlockData[];
  images: ImageBlockData[];
  humor?: HumorBlockData;
};

export type NewspaperTemplateProps = {
  issue: NewspaperIssue;
  content: NewspaperPageContent;
};

export type { NewspaperBlock, NewspaperIssue, NewspaperSource };
