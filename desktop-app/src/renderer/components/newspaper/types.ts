import type { NewspaperBlock, NewspaperIssue, NewspaperNote, NewspaperSource } from '../../lib/api';

export type NewspaperVisualStyle = 'wizarding' | 'editorial' | 'broadsheet' | 'deusEx' | 'massEffect';
export type WeatherBlockData = Extract<NewspaperBlock, { type: 'weather' }>;
export type ArticleBlockData = Extract<NewspaperBlock, { type: 'article' }>;
export type NoteBlockData = Extract<NewspaperBlock, { type: 'note' }>;
export type NotesListBlockData = Extract<NewspaperBlock, { type: 'notes_list' }>;
export type ImageBlockData = Extract<NewspaperBlock, { type: 'image' }>;

export type NewspaperPageContent = {
  weather?: WeatherBlockData;
  hero?: ArticleBlockData;
  articles: ArticleBlockData[];
  notes: NoteBlockData[];
  noteLists: NotesListBlockData[];
  images: ImageBlockData[];
};

export type NewspaperTemplateProps = {
  issue: NewspaperIssue;
  content: NewspaperPageContent;
};

export type { NewspaperBlock, NewspaperIssue, NewspaperNote, NewspaperSource };
