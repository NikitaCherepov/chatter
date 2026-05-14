import React, { useEffect, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { subscribeToolsPanel, getToolsPanelState, setToolsPanelState, type ToolId } from '../lib/tools';
import { NotebookTool } from './NotebookTool';
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

  useEffect(() => {
    const unsub = subscribeToolsPanel((state) => {
      setIsOpen(state.isOpen);
      setActiveToolId(state.activeToolId);
    });
    return unsub;
  }, []);

  const contentMax = isAdmin === 1 ? 3000 : (CONTENT_LIMITS[plan] || 400);
  const tools = useMemo(() => buildTools(contentMax), [contentMax]);

  const panelWidth = isOpen ? 260 : 65;
  const activeTool = tools.find((t) => t.id === activeToolId);

  const handleToggle = () => {
    setToolsPanelState({ isOpen: !isOpen });
  };

  const handleSelectTool = (id: ToolId) => {
    setToolsPanelState({ activeToolId: id });
  };

  const handleBack = () => {
    setToolsPanelState({ activeToolId: null });
  };

  return (
    <motion.aside
      className={s.panel}
      animate={{ width: panelWidth }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
    >
      {/* Header */}
      <div className={s.panelHeader}>
        {/* Left group: back + title */}
        <div className={s.headerLeft}>
          <motion.div
            className={s.backWrap}
            animate={{ width: isOpen && activeToolId ? 28 : 0, marginRight: isOpen && activeToolId ? 8 : 0, opacity: isOpen && activeToolId ? 1 : 0 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: isOpen && activeToolId ? 'auto' : 'none' }}
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
            {activeToolId ? (activeTool?.title || '') : 'Инструменты'}
          </motion.span>
        </div>

        {/* Tools icon — always visible */}
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
          {activeToolId && activeTool ? (
            <motion.div
              key={activeToolId}
              className={s.toolContent}
              initial={{ x: 30, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 30, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {activeTool.id === 'notebook' && (
                <NotebookTool contentMax={activeTool.contentMax ?? contentMax} />
              )}
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
  );
}
