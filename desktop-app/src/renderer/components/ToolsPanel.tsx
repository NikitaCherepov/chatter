import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import {
  subscribeToolsPanel,
  getToolsPanelState,
  setToolsPanelState,
  closeTool,
  getToolNav,
  getToolLayout,
  setToolLayout,
  subscribeToolLayout,
  type ToolId,
  type LayoutMode,
  type ToolLayoutState,
} from '../lib/tools';
import { ToolContent } from './ToolContent';
import { FloatingWidget } from './FloatingWidget';
import s from './ToolsPanel.module.scss';

// ── Tool definitions (registry) ──────────────────────────────────────────

type ToolEntry = {
  id: ToolId;
  title: string;
  description: string;
  icon: React.ReactNode;
  contentMax?: number;
};

const TOOL_ICON_NOTEBOOK = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const TOOL_ICON_TASKS = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

const TOOL_ICON_MAP = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

const TOOL_ICON_GALLERY = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
);

const TOOL_ICON_DOCUMENTS = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);

const TOOL_ICON_BROWSER = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18" />
    <path d="M12 3a15 15 0 0 0 0 18" />
  </svg>
);

const TOOL_ICON_YOUTUBE_MUSIC = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
    <path d="m11 10 3 2-3 2z" fill="currentColor" stroke="none" />
  </svg>
);

const TOOL_ICON_JSON_EXTRACTOR = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2" />
    <path d="M16 3h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2" />
    <path d="M9 12h6" />
  </svg>
);

const buildTools = (contentMax: number, t: (key: string) => string): ToolEntry[] => [
  {
    id: 'notebook',
    title: t('tools.panel.notebook'),
    description: t('tools.panel.notes'),
    icon: TOOL_ICON_NOTEBOOK,
    contentMax,
  },
  {
    id: 'tasks',
    title: t('tools.panel.tasks'),
    description: t('tools.panel.scheduled'),
    icon: TOOL_ICON_TASKS,
  },
  {
    id: 'map',
    title: t('tools.panel.map'),
    description: t('tools.panel.placesRoutes'),
    icon: TOOL_ICON_MAP,
  },
  {
    id: 'gallery',
    title: t('tools.panel.gallery'),
    description: t('tools.panel.chatPhotos'),
    icon: TOOL_ICON_GALLERY,
  },
  {
    id: 'documents',
    title: t('tools.panel.documents'),
    description: t('tools.panel.chatFiles'),
    icon: TOOL_ICON_DOCUMENTS,
  },
  {
    id: 'browser',
    title: t('tools.panel.browser'),
    description: t('tools.panel.webPages'),
    icon: TOOL_ICON_BROWSER,
  },
  {
    id: 'youtube-music',
    title: t('tools.panel.youtubeMusic'),
    description: t('tools.panel.youtubeMusicDescription'),
    icon: TOOL_ICON_YOUTUBE_MUSIC,
  },
  {
    id: 'json-extractor',
    title: t('tools.panel.jsonExtractor'),
    description: t('tools.panel.jsonExtractorDescription'),
    icon: TOOL_ICON_JSON_EXTRACTOR,
  },
];

// ── Component ────────────────────────────────────────────────────────────

type Props = {
  plan: string;
  isAdmin: number;
  activeChatId?: number | null;
  onImageClick?: (src: string, messageId?: number, url?: string) => void;
  onChatSelect?: (chatId: number) => void;
};

const CONTENT_LIMITS: Record<string, number> = {
  free: 400,
  standart: 800,
  pro: 3000,
};

export function ToolsPanel({ plan, isAdmin, activeChatId, onImageClick, onChatSelect }: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(() => getToolsPanelState().isOpen);
  const [openTools, setOpenTools] = useState<ToolId[]>(() => getToolsPanelState().openTools);
  // Per-tool layout states
  const [toolLayouts, setToolLayouts] = useState<Record<string, ToolLayoutState>>({});

  // Subscribe to panel state changes
  useEffect(() => {
    const unsub = subscribeToolsPanel((state) => {
      setIsOpen(state.isOpen);
      setOpenTools(state.openTools);
    });
    return unsub;
  }, []);

  // Subscribe to layout changes for all open tools
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    for (const toolId of openTools) {
      const unsub = subscribeToolLayout(toolId, (layout) => {
        setToolLayouts(prev => ({ ...prev, [toolId]: layout }));
      });
      unsubs.push(unsub);
      // Initialize if not yet tracked
      setToolLayouts(prev => {
        if (prev[toolId]) return prev;
        return { ...prev, [toolId]: getToolLayout(toolId) };
      });
    }
    return () => { unsubs.forEach(fn => fn()); };
  }, [openTools]);

  useEffect(() => window.electronAPI.onToolWindowClosed(({ toolId }) => {
    setToolLayout(toolId, { mode: 'sidebar' });
    const state = getToolsPanelState();
    if (state.openTools.includes(toolId)) setToolsPanelState({ isOpen: true });
  }), []);

  useEffect(() => {
    for (const toolId of openTools) {
      if ((toolLayouts[toolId]?.mode ?? 'sidebar') === 'external') {
        void window.electronAPI.updateToolWindowContext({ toolId, activeChatId }).catch(() => {});
      }
    }
  }, [activeChatId, openTools, toolLayouts]);

  const contentMax = isAdmin === 1 ? 3000 : (CONTENT_LIMITS[plan] || 400);
  const tools = useMemo(() => buildTools(contentMax, t), [contentMax, t]);

  // Find the first tool in sidebar mode (it occupies the sidebar slot)
  const sidebarToolId = openTools.find(id => (toolLayouts[id]?.mode ?? 'sidebar') === 'sidebar') ?? null;
  const sidebarTool = tools.find(t => t.id === sidebarToolId);

  // Sidebar panel width: expanded when open (regardless of whether a tool is active)
  const panelWidth = isOpen
    ? (sidebarToolId === 'browser' || sidebarToolId === 'youtube-music' || sidebarToolId === 'json-extractor' ? 420 : 260)
    : 65;

  const handleToggle = () => {
    setToolsPanelState({ isOpen: !isOpen });
  };

  const handleSelectTool = (id: ToolId) => {
    setToolLayout(id, { mode: 'sidebar' });
    setToolsPanelState({ isOpen: true, openTools: [...openTools.filter(tid => tid !== id), id] });
  };

  const handleBack = () => {
    if (sidebarToolId) {
      const toolBack = getToolNav(sidebarToolId);
      if (toolBack) {
        toolBack();
        return;
      }
    }
    // No internal nav — close the sidebar tool
    if (sidebarToolId) {
      closeTool(sidebarToolId);
    }
  };

  const handleLayoutChange = useCallback((toolId: ToolId, mode: LayoutMode) => {
    setToolLayout(toolId, { mode });
    if (mode === 'external') {
      setToolsPanelState({ isOpen: false });
      const title = tools.find((tool) => tool.id === toolId)?.title || toolId;
      void window.electronAPI.openToolWindow({ toolId, title, activeChatId }).catch((error) => {
        setToolLayout(toolId, { mode: 'sidebar' });
        setToolsPanelState({ isOpen: true });
        toast.error(error?.message || 'Could not open tool window');
      });
    } else if (mode === 'fullscreen' || mode === 'floating') {
      // Collapse sidebar when going out of sidebar mode
      setToolsPanelState({ isOpen: false });
    } else {
      setToolsPanelState({ isOpen: true });
    }
  }, [activeChatId, tools]);

  const handleFloatingPosChange = useCallback((toolId: ToolId, pos: { x: number; y: number }) => {
    setToolLayout(toolId, { floatingPos: pos });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const id = event.active.id as string;
    // id format: "floating-{toolId}"
    const toolId = id.replace('floating-', '');
    const current = getToolLayout(toolId);
    setToolLayout(toolId, {
      floatingPos: {
        x: current.floatingPos.x + event.delta.x,
        y: current.floatingPos.y + event.delta.y,
      },
    });
  }, []);

  const renderToolContent = (toolId: ToolId) => {
    return <ToolContent toolId={toolId} contentMax={contentMax} activeChatId={activeChatId} onImageClick={onImageClick} onChatSelect={onChatSelect} />;
  };

  // Non-sidebar open tools (for floating/fullscreen windows)
  const floatingTools = openTools.filter(id => {
    const mode = toolLayouts[id]?.mode ?? 'sidebar';
    return mode === 'floating' || mode === 'fullscreen';
  });

  return (
    <DndContext
      modifiers={[restrictToWindowEdges]}
      onDragEnd={handleDragEnd}
    >
      {/* Sidebar (always rendered) */}
      <motion.aside
        className={s.panel}
        animate={{ width: panelWidth }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
      >
        {/* Header */}
        <div className={s.panelHeader}>
          <div className={s.headerLeft}>
            <motion.div
              className={s.backWrap}
              animate={{ width: isOpen && sidebarToolId ? 28 : 0, marginRight: isOpen && sidebarToolId ? 8 : 0, opacity: isOpen && sidebarToolId ? 1 : 0 }}
              transition={{ duration: 0.15 }}
              style={{ pointerEvents: isOpen && sidebarToolId ? 'auto' : 'none' }}
            >
              <button className={s.backBtn} onClick={handleBack} title={t('common.back')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            </motion.div>
            <motion.span
              className={s.panelTitle}
              animate={{ opacity: isOpen ? 1 : 0 }}
              transition={{ duration: 0.15 }}
            >
              {sidebarToolId && sidebarTool ? sidebarTool.title : t('tools.panel.tools')}
            </motion.span>
            {/* Layout mode buttons — visible when a tool is active in sidebar */}
            {isOpen && sidebarToolId && (
              <div className={s.layoutBtns}>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange(sidebarToolId, 'floating')} title={t('tools.panel.floating')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="5" width="14" height="14" rx="2" ry="2" />
                  </svg>
                </button>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange(sidebarToolId, 'fullscreen')} title={t('tools.panel.fullscreen')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </button>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange(sidebarToolId, 'external')} title={t('widget.external', { defaultValue: 'Open in separate window' })}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 3h7v7" />
                    <path d="M10 14L21 3" />
                    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          <button className={s.toolsIconBtn} onClick={handleToggle} title={isOpen ? t('tools.panel.collapse') : t('tools.panel.tools')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <motion.div
          className={s.panelBody}
          animate={{ opacity: isOpen ? 1 : 0 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
        >
          <AnimatePresence mode="wait">
            {sidebarToolId && sidebarTool ? (
              <motion.div
                key={sidebarToolId}
                className={s.toolContent}
                initial={{ x: 30, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 30, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {renderToolContent(sidebarToolId)}
              </motion.div>
            ) : (
              <motion.div
                key="tool-list"
                className={s.toolList}
                initial={{ x: -30, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -30, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {tools.map((tool) => (
                  <button
                    key={tool.id}
                    className={s.toolItem}
                    onClick={() => handleSelectTool(tool.id)}
                  >
                    <div className={s.toolIcon}>{tool.icon}</div>
                    <div className={s.toolInfo}>
                      <div className={s.toolItemTitle}>{tool.title}</div>
                      <div className={s.toolItemDesc}>{tool.description}</div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-hint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.aside>

      {/* Floating / Fullscreen overlays — one per open non-sidebar tool */}
      {floatingTools.map((toolId) => {
        const layout = toolLayouts[toolId] ?? { mode: 'floating' as LayoutMode, floatingPos: { x: 50, y: 50 } };
        const tool = tools.find(t => t.id === toolId);
        return (
          <FloatingWidget
            key={toolId}
            dragId={`floating-${toolId}`}
            layoutMode={layout.mode}
            floatingPos={layout.floatingPos}
            onFloatingPosChange={(pos) => handleFloatingPosChange(toolId, pos)}
            onLayoutChange={(mode) => handleLayoutChange(toolId, mode)}
            onClose={() => closeTool(toolId)}
            title={tool?.title || ''}
          >
            {renderToolContent(toolId)}
          </FloatingWidget>
        );
      })}
    </DndContext>
  );
}
