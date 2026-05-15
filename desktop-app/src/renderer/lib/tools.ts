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
  /** Ordered list of currently open tool IDs. First = sidebar tool, rest may be floating/fullscreen. */
  openTools: ToolId[];
};

type Listener = (state: ToolsPanelState) => void;

const listeners = new Set<Listener>();
let currentState: ToolsPanelState = { isOpen: false, openTools: [] };

export function getToolsPanelState(): ToolsPanelState {
  return { ...currentState, openTools: [...currentState.openTools] };
}

export function setToolsPanelState(patch: Partial<ToolsPanelState>) {
  currentState = { ...currentState, ...patch };
  listeners.forEach((fn) => fn(getToolsPanelState()));
}

export function subscribeToolsPanel(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Open a tool — adds to openTools if not already there.
 * This is the primary API for external callers (e.g. bot).
 */
export function openTool(toolId?: ToolId) {
  if (!toolId) {
    setToolsPanelState({ isOpen: true });
    return;
  }
  const next = currentState.openTools.includes(toolId)
    ? currentState.openTools
    : [...currentState.openTools, toolId];
  setToolsPanelState({ isOpen: true, openTools: next });
}

/**
 * Close a specific tool — removes from openTools.
 */
export function closeTool(toolId: ToolId) {
  setToolsPanelState({ openTools: currentState.openTools.filter(id => id !== toolId) });
}

/**
 * Close the tools panel. Keeps openTools so reopening returns to same state.
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

// ── Tool Layout Mode ─────────────────────────────────────────────────────

export type LayoutMode = 'sidebar' | 'fullscreen' | 'floating';

export type ToolLayoutState = {
  mode: LayoutMode;
  floatingPos: { x: number; y: number };
};

type LayoutListener = (state: ToolLayoutState) => void;

const layoutState = new Map<ToolId, ToolLayoutState>();
const layoutListeners = new Map<ToolId, Set<LayoutListener>>();

export function getToolLayout(toolId: ToolId): ToolLayoutState {
  return layoutState.get(toolId) ?? { mode: 'sidebar', floatingPos: { x: 50, y: 50 } };
}

export function setToolLayout(toolId: ToolId, patch: Partial<ToolLayoutState>) {
  const current = getToolLayout(toolId);
  const next = { ...current, ...patch };
  if (patch.floatingPos) {
    next.floatingPos = { ...current.floatingPos, ...patch.floatingPos };
  }
  layoutState.set(toolId, next);
  layoutListeners.get(toolId)?.forEach(fn => fn(next));
}

export function subscribeToolLayout(toolId: ToolId, fn: LayoutListener): () => void {
  if (!layoutListeners.has(toolId)) layoutListeners.set(toolId, new Set());
  layoutListeners.get(toolId)!.add(fn);
  return () => { layoutListeners.get(toolId)?.delete(fn); };
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

// ── Map Data (bot → map widget via SSE) ────────────────────────────────────

export type MapData = {
  action: 'show_place' | 'draw_route';
  lat?: number;
  lng?: number;
  label?: string;
  from?: { lat: number; lng: number; label: string };
  to?: { lat: number; lng: number; label: string };
  route?: [number, number][];
};

type MapDataListener = (data: MapData) => void;

const mapListeners = new Set<MapDataListener>();

export function dispatchMapData(data: MapData) {
  mapListeners.forEach(fn => fn(data));
}

export function subscribeMapData(fn: MapDataListener): () => void {
  mapListeners.add(fn);
  return () => { mapListeners.delete(fn); };
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
    if (action.target) {
      closeTool(action.target);
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
