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

// ── Tool Navigation (tool -> panel back button) ──────────────────────────

type NavListener = () => void;

const navCallbacks = new Map<ToolId, NavListener>();

/** Register an onBack callback for a tool. Returns unsubscribe fn. */
export function registerToolNav(toolId: ToolId, onBack: NavListener | null): () => void {
  if (onBack) {
    navCallbacks.set(toolId, onBack);
  } else {
    navCallbacks.delete(toolId);
  }
  return () => { navCallbacks.delete(toolId); };
}

/** Get the current onBack callback for a tool (or null). Used by ToolsPanel. */
export function getToolNav(toolId: ToolId): NavListener | null {
  return navCallbacks.get(toolId) ?? null;
}

// ── Widget Data Commands (bot -> widget) ─────────────────────────────────

export type WidgetDataCommand = {
  type: 'set_draft' | 'open_note';
  title?: string;
  content?: string;
  noteId?: number;
};

type WidgetDataListener = (cmd: WidgetDataCommand) => void;

const widgetListeners = new Map<string, Set<WidgetDataListener>>();
// Pending commands that arrived before any listener subscribed
const pendingCommands = new Map<string, WidgetDataCommand[]>();

export function subscribeWidgetData(widgetId: string, fn: WidgetDataListener): () => void {
  if (!widgetListeners.has(widgetId)) widgetListeners.set(widgetId, new Set());
  widgetListeners.get(widgetId)!.add(fn);
  // Drain pending commands
  const pending = pendingCommands.get(widgetId);
  if (pending) {
    pendingCommands.delete(widgetId);
    for (const cmd of pending) fn(cmd);
  }
  return () => { widgetListeners.get(widgetId)?.delete(fn); };
}

export function dispatchWidgetData(widgetId: string, cmd: WidgetDataCommand) {
  const listeners = widgetListeners.get(widgetId);
  if (listeners && listeners.size > 0) {
    listeners.forEach((fn) => fn(cmd));
  } else {
    // No listener yet — queue it
    if (!pendingCommands.has(widgetId)) pendingCommands.set(widgetId, []);
    pendingCommands.get(widgetId)!.push(cmd);
  }
}

// ── Widget State Queries (bot reads widget state) ─────────────────────────

let notebookDraftState: { title: string; content: string; isOpen: boolean } = { title: '', content: '', isOpen: false };

export function setNotebookDraftState(state: { title: string; content: string; isOpen: boolean }) {
  notebookDraftState = state;
}

export function getNotebookDraftState() {
  return { ...notebookDraftState };
}

// ── Handle incoming desktop_action from bot ───────────────────────────────

export function handleDesktopAction(action: { action: string; target?: string; value?: { title?: string; content?: string } }) {
  const a = action.action;

  if (a === 'toggle_panel') {
    toggleToolsPanel();
    return;
  }

  if (a === 'open_widget') {
    const toolId = action.target === 'notebook' ? 'notebook' : action.target;
    openTool(toolId);
    return;
  }

  if (a === 'close_widget') {
    if (action.target && currentState.activeToolId === action.target) {
      setToolsPanelState({ activeToolId: null });
    }
    return;
  }

  if (a === 'set_widget_data' && action.target === 'notebook') {
    openTool('notebook');
    dispatchWidgetData('notebook', {
      type: 'set_draft',
      title: action.value?.title,
      content: action.value?.content,
    });
    return;
  }

  if (a === 'open_note' && action.target === 'notebook') {
    openTool('notebook');
    const noteId = typeof action.value === 'object' && action.value !== null
      ? (action.value as { note_id?: number }).note_id
      : undefined;
    if (noteId) {
      dispatchWidgetData('notebook', {
        type: 'open_note',
        noteId,
      });
    }
    return;
  }

  if (a === 'read_widget_state' && action.target === 'notebook') {
    // This is a query -- the bot reads state from the tool result
    // The actual state is read server-side or from getNotebookDraftState
    // For now this is informational
    return;
  }
}
