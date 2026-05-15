import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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
import { NotebookTool } from './NotebookTool';
import { TasksTool } from './TasksTool';
import { MapTool } from './MapTool';
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

const buildTools = (contentMax: number): ToolEntry[] => [
  {
    id: 'notebook',
    title: 'Блокнот',
    description: 'Заметки',
    icon: TOOL_ICON_NOTEBOOK,
    contentMax,
  },
  {
    id: 'tasks',
    title: 'Задачи',
    description: 'Запланированные',
    icon: TOOL_ICON_TASKS,
  },
  {
    id: 'map',
    title: 'Карта',
    description: 'Места и маршруты',
    icon: TOOL_ICON_MAP,
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

  const contentMax = isAdmin === 1 ? 3000 : (CONTENT_LIMITS[plan] || 400);
  const tools = useMemo(() => buildTools(contentMax), [contentMax]);

  // Find the first tool in sidebar mode (it occupies the sidebar slot)
  const sidebarToolId = openTools.find(id => (toolLayouts[id]?.mode ?? 'sidebar') === 'sidebar') ?? null;
  const sidebarTool = tools.find(t => t.id === sidebarToolId);

  // Sidebar panel width: expanded when open (regardless of whether a tool is active)
  const panelWidth = isOpen ? 260 : 65;

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
    if (mode === 'fullscreen' || mode === 'floating') {
      // Collapse sidebar when going out of sidebar mode
      setToolsPanelState({ isOpen: false });
    } else {
      setToolsPanelState({ isOpen: true });
    }
  }, []);

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
    const tool = tools.find(t => t.id === toolId);
    if (toolId === 'notebook') {
      return <NotebookTool contentMax={tool?.contentMax ?? contentMax} />;
    }
    if (toolId === 'tasks') {
      return <TasksTool />;
    }
    if (toolId === 'map') {
      return <MapTool />;
    }
    return null;
  };

  // Non-sidebar open tools (for floating/fullscreen windows)
  const floatingTools = openTools.filter(id => (toolLayouts[id]?.mode ?? 'sidebar') !== 'sidebar');

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
              {sidebarToolId && sidebarTool ? sidebarTool.title : 'Инструменты'}
            </motion.span>
            {/* Layout mode buttons — visible when a tool is active in sidebar */}
            {isOpen && sidebarToolId && (
              <div className={s.layoutBtns}>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange(sidebarToolId, 'floating')} title="Плавающее окно">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="5" width="14" height="14" rx="2" ry="2" />
                  </svg>
                </button>
                <button className={s.layoutBtn} onClick={() => handleLayoutChange(sidebarToolId, 'fullscreen')} title="На весь экран">
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
