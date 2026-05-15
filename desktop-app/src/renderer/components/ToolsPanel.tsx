import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import {
  subscribeToolsPanel,
  getToolsPanelState,
  setToolsPanelState,
  getToolNav,
  getToolLayout,
  setToolLayout,
  subscribeToolLayout,
  type ToolId,
  type LayoutMode,
} from '../lib/tools';
import { NotebookTool } from './NotebookTool';
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

const buildTools = (contentMax: number): ToolEntry[] => [
  {
    id: 'notebook',
    title: 'Блокнот',
    description: 'Заметки',
    icon: TOOL_ICON_NOTEBOOK,
    contentMax,
  },
];

// ── Component ────────────────────────────────────────────────────────────

type Props = {
  plan: string;
  isAdmin: number;
};

const CONTENT_LIMITS: Record<string, number> = {
  free: 400,
  standart: 800,
  pro: 3000,
};

export function ToolsPanel({ plan, isAdmin }: Props) {
  const [isOpen, setIsOpen] = useState(() => getToolsPanelState().isOpen);
  const [activeToolId, setActiveToolId] = useState<ToolId | null>(() => getToolsPanelState().activeToolId);
  const [layoutState, setLayoutState] = useState(() => activeToolId ? getToolLayout(activeToolId) : { mode: 'sidebar' as LayoutMode, floatingPos: { x: 50, y: 50 } });

  useEffect(() => {
    const unsub = subscribeToolsPanel((state) => {
      setIsOpen(state.isOpen);
      setActiveToolId(state.activeToolId);
      // Sync layout state when active tool changes
      if (state.activeToolId) {
        setLayoutState(getToolLayout(state.activeToolId));
      }
    });
    return unsub;
  }, []);

  // Subscribe to layout changes for the active tool
  useEffect(() => {
    if (!activeToolId) return;
    const unsub = subscribeToolLayout(activeToolId, setLayoutState);
    return unsub;
  }, [activeToolId]);

  const contentMax = isAdmin === 1 ? 3000 : (CONTENT_LIMITS[plan] || 400);
  const tools = useMemo(() => buildTools(contentMax), [contentMax]);

  const layoutMode = layoutState.mode;
  const isSidebar = layoutMode === 'sidebar';
  // In sidebar mode, panel expands. In floating/fullscreen, panel is collapsed.
  const panelWidth = (isOpen && isSidebar) ? 260 : 65;
  const activeTool = tools.find((t) => t.id === activeToolId);

  // If floating or fullscreen, hide the tool from sidebar list
  const sidebarTools = layoutMode !== 'sidebar' && activeToolId
    ? tools.filter(t => t.id !== activeToolId)
    : tools;

  const handleToggle = () => {
    if (layoutMode !== 'sidebar' && activeToolId) {
      // If in floating/fullscreen, clicking the icon goes back to sidebar
      setToolLayout(activeToolId, { mode: 'sidebar' });
    }
    setToolsPanelState({ isOpen: !isOpen });
  };

  const handleSelectTool = (id: ToolId) => {
    setToolsPanelState({ activeToolId: id });
  };

  const handleBack = () => {
    if (activeToolId) {
      const toolBack = getToolNav(activeToolId);
      if (toolBack) {
        toolBack();
        return;
      }
    }
    setToolsPanelState({ activeToolId: null });
  };

  const handleLayoutChange = useCallback((mode: LayoutMode) => {
    if (!activeToolId) return;
    setToolLayout(activeToolId, { mode });
    if (mode === 'fullscreen' || mode === 'floating') {
      // Collapse sidebar when going out of sidebar mode
      setToolsPanelState({ isOpen: false });
    } else {
      setToolsPanelState({ isOpen: true });
    }
  }, [activeToolId]);

  const handleFloatingPosChange = useCallback((pos: { x: number; y: number }) => {
    if (!activeToolId) return;
    setToolLayout(activeToolId, { floatingPos: pos });
  }, [activeToolId]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (!activeToolId) return;
    const current = getToolLayout(activeToolId);
    setToolLayout(activeToolId, {
      floatingPos: {
        x: current.floatingPos.x + event.delta.x,
        y: current.floatingPos.y + event.delta.y,
      },
    });
  }, [activeToolId]);

  const renderToolContent = (toolId: ToolId) => {
    if (toolId === 'notebook') {
      return <NotebookTool contentMax={activeTool?.contentMax ?? contentMax} />;
    }
    return null;
  };

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
              animate={{ width: isOpen && activeToolId && isSidebar ? 28 : 0, marginRight: isOpen && activeToolId && isSidebar ? 8 : 0, opacity: isOpen && activeToolId && isSidebar ? 1 : 0 }}
              transition={{ duration: 0.15 }}
              style={{ pointerEvents: isOpen && activeToolId && isSidebar ? 'auto' : 'none' }}
            >
              <button className={s.backBtn} onClick={handleBack} title="Назад">
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
              {activeToolId && isSidebar ? (activeTool?.title || '') : 'Инструменты'}
            </motion.span>
            {/* Layout mode buttons — visible when a tool is active and sidebar is open */}
            {isOpen && activeToolId && isSidebar && (
              <div className={s.layoutBtns}>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange('floating')} title="Плавающее окно">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="5" width="14" height="14" rx="2" ry="2" />
                  </svg>
                </button>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange('fullscreen')} title="На весь экран">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          <button className={s.toolsIconBtn} onClick={handleToggle} title={isOpen ? 'Свернуть' : 'Инструменты'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </button>
        </div>

        {/* Body — only shows in sidebar mode */}
        <motion.div
          className={s.panelBody}
          animate={{ opacity: isOpen ? 1 : 0 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
        >
          <AnimatePresence mode="wait">
            {activeToolId && isSidebar && activeTool ? (
              <motion.div
                key={activeToolId}
                className={s.toolContent}
                initial={{ x: 30, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 30, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {renderToolContent(activeToolId)}
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
                {sidebarTools.map((tool) => (
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

      {/* Floating / Fullscreen overlay */}
      {activeToolId && !isSidebar && (
        <FloatingWidget
          layoutMode={layoutMode}
          floatingPos={layoutState.floatingPos}
          onFloatingPosChange={handleFloatingPosChange}
          onLayoutChange={handleLayoutChange}
          title={activeTool?.title || ''}
        >
          {renderToolContent(activeToolId)}
        </FloatingWidget>
      )}
    </DndContext>
  );
}
