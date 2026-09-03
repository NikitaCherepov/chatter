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
  const next = [toolId, ...currentState.openTools.filter(id => id !== toolId)];
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

export type LayoutMode = 'sidebar' | 'fullscreen' | 'floating' | 'external';

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
const WIDGET_COMMAND_KEY_PREFIX = 'chatter_widget_command:';

function deliverWidgetData(widgetId: string, cmd: WidgetDataCommand) {
  const listeners = widgetListeners.get(widgetId);
  if (listeners && listeners.size > 0) {
    listeners.forEach((fn) => fn(cmd));
  } else {
    if (!pendingCommands.has(widgetId)) pendingCommands.set(widgetId, []);
    pendingCommands.get(widgetId)!.push(cmd);
  }
}

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
  deliverWidgetData(widgetId, cmd);
  try {
    localStorage.setItem(`${WIDGET_COMMAND_KEY_PREFIX}${widgetId}`, JSON.stringify({ nonce: crypto.randomUUID(), cmd }));
  } catch {}
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith(WIDGET_COMMAND_KEY_PREFIX) || !event.newValue) return;
    try {
      const widgetId = event.key.slice(WIDGET_COMMAND_KEY_PREFIX.length);
      const payload = JSON.parse(event.newValue) as { cmd?: WidgetDataCommand };
      if (payload.cmd) deliverWidgetData(widgetId, payload.cmd);
    } catch {}
  });
}

// ── Map Data (bot → map widget via SSE) ────────────────────────────────────

export type TransitStop = {
  coords: [number, number]; // [lat, lng]
  name: string;
};

export type NearbyPlace = {
  id: number;
  lat: number;
  lng: number;
  name: string;
  address?: string;
  hours?: string;
  category?: string;
};

export type MapData = {
  action: 'show_place' | 'draw_route' | 'transit_route' | 'poi_search';
  lat?: number;
  lng?: number;
  label?: string;
  from?: { lat: number; lng: number; label: string };
  to?: { lat: number; lng: number; label: string };
  route?: [number, number][];
  // transit_route fields
  routeName?: string;
  path?: [number, number][]; // [lat, lng][] — full route polyline
  stops?: TransitStop[];
  // poi_search fields
  places?: NearbyPlace[];
  query?: string;
};

type MapDataListener = (data: MapData) => void;

const mapListeners = new Set<MapDataListener>();
const MAP_DATA_STORAGE_KEY = 'chatter_tool_map_data';
let currentMapData: MapData | null = (() => {
  try { return JSON.parse(localStorage.getItem(MAP_DATA_STORAGE_KEY) || 'null') as MapData | null; } catch { return null; }
})();

export function dispatchMapData(data: MapData) {
  currentMapData = data;
  try { localStorage.setItem(MAP_DATA_STORAGE_KEY, JSON.stringify(data)); } catch {}
  mapListeners.forEach(fn => fn(data));
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== MAP_DATA_STORAGE_KEY || !event.newValue) return;
    try {
      currentMapData = JSON.parse(event.newValue) as MapData;
      mapListeners.forEach((fn) => fn(currentMapData!));
    } catch {}
  });
}

export function getMapData(): MapData | null {
  return currentMapData;
}

export function subscribeMapData(fn: MapDataListener): () => void {
  mapListeners.add(fn);
  return () => { mapListeners.delete(fn); };
}

// ── Widget State Queries (bot reads widget state) ─────────────────────────

const NOTEBOOK_DRAFT_STORAGE_KEY = 'chatter_tool_notebook_draft';
let notebookDraftState: { title: string; content: string; isOpen: boolean } = (() => {
  try {
    return JSON.parse(localStorage.getItem(NOTEBOOK_DRAFT_STORAGE_KEY) || 'null')
      || { title: '', content: '', isOpen: false };
  } catch {
    return { title: '', content: '', isOpen: false };
  }
})();

export function setNotebookDraftState(state: { title: string; content: string; isOpen: boolean }) {
  notebookDraftState = state;
  try { localStorage.setItem(NOTEBOOK_DRAFT_STORAGE_KEY, JSON.stringify(state)); } catch {}
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
    if (!toolId) return;
    const panelState = getToolsPanelState();
    const existingLayout = getToolLayout(toolId);
    if (panelState.openTools.includes(toolId) && existingLayout.mode === 'external') {
      void window.electronAPI.openToolWindow({ toolId, title: toolId }).catch((error) => {
        console.error('[tools] failed to focus detached tool window:', error);
      });
      return;
    }
    if (toolId === 'browser') {
      setToolLayout('browser', { mode: 'sidebar' });
      openTool(toolId);
      setToolsPanelState({ isOpen: true });
      return;
    }
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

  // ── Macro actions ──

  if (a === 'execute_macro') {
    // target === '__explore_fs__' means AI requested directory listing
    if (action.target === '__explore_fs__') {
      const val = action.value as { target_path?: string } | undefined;
      if (val?.target_path && window.electronAPI?.readDirectory) {
        window.electronAPI.readDirectory(val.target_path).catch(err => {
          console.error('[macro] read-directory failed:', err);
        });
      }
      return;
    }

    // Normal macro execution — commands are included in the payload from server
    const val = action.value as { macro_name?: string; commands?: string[] } | undefined;
    const commands = val?.commands;
    if (commands?.length && window.electronAPI?.executeCommands) {
      window.electronAPI.executeCommands(commands).catch(err => {
        console.error('[macro] execute failed:', err);
      });
    } else {
      console.warn('[macro] execute_macro: no commands in payload', action);
    }
    return;
  }

  if (a === 'suggest_macro') {
    // This action is handled by ChatPage via the suggest_macro callback
    // The payload is forwarded through the SSE desktop_action event
    // ChatPage will render a special card for it
    return;
  }

  if (a === 'suggest_chat_link') {
    // Handled by ChatPage via handleIncomingDesktopAction
    // Renders an inline card with a button to open the chat
    return;
  }

  if (a === 'suggest_devops_runbook') {
    // Handled by ChatPage via the suggestDevopsRunbook callback
    return;
  }

  if (a === 'suggest_server_creds_update') {
    // Handled by ChatPage via the suggestServerCredsUpdate callback
    return;
  }

  // ── DevOps confirmation ──

  if (a === 'devops_confirmation') {
    // Handled by ChatPage via the devopsConfirmation callback
    // Renders a confirmation card: [Approve] [Reject]
    return;
  }

  // ── PC Command confirmation ──

  if (a === 'pc_command_confirmation') {
    // Handled by ChatPage via the pcCommandConfirmation callback
    // Renders a confirmation card: [Approve] [Reject]
    return;
  }

  if (a === 'browser_action_confirmation') {
    // Handled by ChatPage with a dedicated confirmation card.
    return;
  }

  if (a === 'browser_action_confirmation_resolved') {
    // Handled by ChatPage; removes a card resolved in Desktop or Telegram.
    return;
  }

  if (a === 'browser_download_confirmation' || a === 'browser_download_confirmation_resolved') {
    // Handled by ChatPage with a dedicated download confirmation card.
    return;
  }

  // ── Webcam Capture confirmation ──

  if (a === 'webcam_capture_confirmation') {
    // Handled by ChatPage via the webcamCaptureConfirmation callback
    // Renders a confirmation card: [Approve] [Reject]
    return;
  }
}

// ── Suggest Macro callback ──────────────────────────────────────────────────

type SuggestMacroPayload = {
  title: string;
  description?: string;
  commands: string[];
};

type SuggestMacroListener = (payload: SuggestMacroPayload) => void;

const suggestMacroListeners = new Set<SuggestMacroListener>();

export function subscribeSuggestMacro(listener: SuggestMacroListener): () => void {
  suggestMacroListeners.add(listener);
  return () => suggestMacroListeners.delete(listener);
}

export function emitSuggestMacro(payload: SuggestMacroPayload) {
  suggestMacroListeners.forEach(fn => fn(payload));
}

// ── DevOps Confirmation callback ────────────────────────────────────────────

export type DevopsConfirmationPayload = {
  confirmation_id: string;
  server_name: string;
  server_id: number;
  host: string;
  command: string;
};

type DevopsConfirmationListener = (payload: DevopsConfirmationPayload) => void;

const devopsConfirmationListeners = new Set<DevopsConfirmationListener>();

export function subscribeDevopsConfirmation(listener: DevopsConfirmationListener): () => void {
  devopsConfirmationListeners.add(listener);
  return () => devopsConfirmationListeners.delete(listener);
}

export function emitDevopsConfirmation(payload: DevopsConfirmationPayload) {
  devopsConfirmationListeners.forEach(fn => fn(payload));
}

// ── Suggest DevOps Runbook callback ────────────────────────────────────────

export type SuggestDevopsRunbookPayload = {
  title: string;
  content: string;
  commands: string[];
};

type SuggestDevopsRunbookListener = (payload: SuggestDevopsRunbookPayload) => void;

const suggestDevopsRunbookListeners = new Set<SuggestDevopsRunbookListener>();

export function subscribeSuggestDevopsRunbook(listener: SuggestDevopsRunbookListener): () => void {
  suggestDevopsRunbookListeners.add(listener);
  return () => suggestDevopsRunbookListeners.delete(listener);
}

export function emitSuggestDevopsRunbook(payload: SuggestDevopsRunbookPayload) {
  suggestDevopsRunbookListeners.forEach(fn => fn(payload));
}

// ── Suggest Server Creds Update callback ───────────────────────────────────

export type SuggestServerCredsUpdatePayload = {
  server_id: number;
  server_name: string;
  current_username: string;
  new_username: string;
  reason: string;
  use_ssh_key: boolean;
  remove_password: boolean;
};

type SuggestServerCredsUpdateListener = (payload: SuggestServerCredsUpdatePayload) => void;

const suggestServerCredsUpdateListeners = new Set<SuggestServerCredsUpdateListener>();

export function subscribeSuggestServerCredsUpdate(listener: SuggestServerCredsUpdateListener): () => void {
  suggestServerCredsUpdateListeners.add(listener);
  return () => suggestServerCredsUpdateListeners.delete(listener);
}

export function emitSuggestServerCredsUpdate(payload: SuggestServerCredsUpdatePayload) {
  suggestServerCredsUpdateListeners.forEach(fn => fn(payload));
}

// ── PC Command Confirmation callback ────────────────────────────────────────

export type PcCommandConfirmationPayload = {
  confirmation_id: string;
  command: string;
};

type PcCommandConfirmationListener = (payload: PcCommandConfirmationPayload) => void;

const pcCommandConfirmationListeners = new Set<PcCommandConfirmationListener>();

export function subscribePcCommandConfirmation(listener: PcCommandConfirmationListener): () => void {
  pcCommandConfirmationListeners.add(listener);
  return () => pcCommandConfirmationListeners.delete(listener);
}

export function emitPcCommandConfirmation(payload: PcCommandConfirmationPayload) {
  pcCommandConfirmationListeners.forEach(fn => fn(payload));
}
