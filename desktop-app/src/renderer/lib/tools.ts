import type { ReactNode } from 'react';

// ── Tool Definition ──────────────────────────────────────────────────────

export type ToolId = string;

export type ToolDefinition = {
  id: ToolId;
  title: string;
  description: string;
  icon: 'notebook' | 'calculator' | 'calendar' | 'tasks'; // extend as needed
  /** The component to render when this tool is active */
  component: ReactNode;
};

// ── Tool Registry (simple pub/sub for external control) ──────────────────

type ToolsPanelState = {
  isOpen: boolean;
  activeToolId: ToolId | null;
};

type Listener = (state: ToolsPanelState) => void;

const listeners = new Set<Listener>();
let currentState: ToolsPanelState = { isOpen: false, activeToolId: null };

export function getToolsPanelState(): ToolsPanelState {
  return { ...currentState };
}

export function setToolsPanelState(patch: Partial<ToolsPanelState>) {
  currentState = { ...currentState, ...patch };
  listeners.forEach((fn) => fn({ ...currentState }));
}

export function subscribeToolsPanel(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Open the tools panel and optionally activate a specific tool.
 * This is the primary API for external callers (e.g. bot).
 */
export function openTool(toolId?: ToolId) {
  setToolsPanelState({ isOpen: true, activeToolId: toolId ?? currentState.activeToolId });
}

/**
 * Close the tools panel. Keeps activeToolId so reopening returns to same state.
 */
export function closeToolsPanel() {
  setToolsPanelState({ isOpen: false });
}

/**
 * Toggle the tools panel open/closed.
 */
export function toggleToolsPanel() {
  if (currentState.isOpen) {
    closeToolsPanel();
  } else {
    setToolsPanelState({ isOpen: true });
  }
}
