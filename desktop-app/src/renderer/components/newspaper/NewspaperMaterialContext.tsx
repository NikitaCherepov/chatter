import { createContext, useContext, type ReactNode } from 'react';
import type { ArticleBlockData, NewspaperNote, NoteBlockData } from './types';

export type NewspaperMaterial = {
  id: string;
  kind: 'article' | 'note';
  title: string;
  text: string;
  url?: string;
  imageUrl?: string;
  sources?: ArticleBlockData['sources'];
};

type OpenMaterial = (material: NewspaperMaterial) => void;
const Context = createContext<OpenMaterial | null>(null);

export const articleMaterial = (article: ArticleBlockData): NewspaperMaterial => ({
  id: article.id,
  kind: 'article',
  title: article.title,
  text: article.text,
  url: article.url,
  imageUrl: article.image_url,
  sources: article.sources,
});

export const noteMaterial = (note: NewspaperNote | NoteBlockData, fallbackId: string): NewspaperMaterial => ({
  id: note.id || fallbackId,
  kind: 'note',
  title: note.title || 'Короткая заметка',
  text: note.text || '',
  url: note.url,
  imageUrl: note.image_url,
});

export function NewspaperMaterialProvider({ onOpen, children }: { onOpen: OpenMaterial; children: ReactNode }) {
  return <Context.Provider value={onOpen}>{children}</Context.Provider>;
}

export const useNewspaperMaterialViewer = () => useContext(Context);
