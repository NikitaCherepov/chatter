import { createContext, useContext, type ReactNode } from 'react';

type OpenImage = (src: string, title?: string) => void;

const NewspaperImageViewerContext = createContext<OpenImage | null>(null);

export function NewspaperImageViewerProvider({ onOpen, children }: { onOpen: OpenImage; children: ReactNode }) {
  return <NewspaperImageViewerContext.Provider value={onOpen}>{children}</NewspaperImageViewerContext.Provider>;
}

export function useNewspaperImageViewer() {
  return useContext(NewspaperImageViewerContext);
}

