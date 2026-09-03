import React from 'react';
import { BrowserTool } from './BrowserTool';
import { DocumentsTool } from './DocumentsTool';
import { GalleryTool } from './GalleryTool';
import { MapTool } from './MapTool';
import { NotebookTool } from './NotebookTool';
import { TasksTool } from './TasksTool';
import { JsonExtractorTool } from './JsonExtractorTool';
import { YouTubeMusicTool } from './YouTubeMusicTool';

type Props = {
  toolId: string;
  contentMax: number;
  activeChatId?: number | null;
  onImageClick?: (src: string, messageId?: number, url?: string) => void;
  onChatSelect?: (chatId: number) => void;
};

export function ToolContent({ toolId, contentMax, activeChatId, onImageClick, onChatSelect }: Props) {
  if (toolId === 'notebook') return <NotebookTool contentMax={contentMax} />;
  if (toolId === 'tasks') return <TasksTool />;
  if (toolId === 'map') return <MapTool />;
  if (toolId === 'gallery') {
    return <GalleryTool chatId={activeChatId ?? null} onImageClick={onImageClick} onChatSelect={onChatSelect} />;
  }
  if (toolId === 'documents') return <DocumentsTool chatId={activeChatId ?? null} />;
  if (toolId === 'browser') return <BrowserTool />;
  if (toolId === 'youtube-music') return <YouTubeMusicTool />;
  if (toolId === 'json-extractor') return <JsonExtractorTool />;
  return null;
}
