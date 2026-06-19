const API_BASE: string = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3050';

export { API_BASE };

type Tokens = {
  access_token: string;
  refresh_token: string;
  access_expires_in: number;
  refresh_expires_in: number;
};

type User = {
  id: number;
  name: string | null;
  username: string | null;
  role: string;
  is_admin: number;
  plan: string;
  selected_prompt_id: number | null;
  custom_prompt_content: string | null;
  core_memory: string | null;
};

// ---------- Token storage ----------

const TOKEN_KEY = 'chatter_tokens';

export function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

// ---------- Fetch wrapper ----------

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const tokens = loadTokens();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (tokens?.access_token) {
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && tokens?.refresh_token && !path.includes('/auth/')) {
    const refreshed = await refreshToken(tokens.refresh_token);
    if (refreshed) {
      saveTokens(refreshed);
      // Reconnect WebSocket with new token
      reconnectWebSocket();
      headers['Authorization'] = `Bearer ${refreshed.access_token}`;
      const retry = await fetch(`${API_BASE}${path}`, { ...options, headers });
      return retry.json();
    }
    clearTokens();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || 'unknown_error', body);
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

// ---------- Auth ----------

export type AuthResponse = Tokens & { user: User };

export async function register(login: string, password: string, name?: string): Promise<AuthResponse> {
  const body: Record<string, string> = { login, password };
  if (name) body.name = name;
  const res = await apiFetch<AuthResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  saveTokens(res);
  return res;
}

export async function login(login: string, password: string): Promise<AuthResponse> {
  const res = await apiFetch<AuthResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login, password }),
  });
  saveTokens(res);
  return res;
}

export async function refreshToken(refresh_token: string): Promise<Tokens | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export function logout() {
  clearTokens();
}

export async function fetchMe(): Promise<User> {
  const res = await apiFetch<{ user: User }>('/api/v1/auth/me');
  return res.user;
}

// ---------- Chat ----------

export type MessageImage = {
  url: string;
  type: 'user_photo' | 'generated';
};

export type MessageAudio = {
  url: string;
  tts_type: string;
  voice_id: string;
};

export type ToolCall = { id?: string; name: string; arguments: any; result_preview?: string };

export type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[] | null;
  images?: MessageImage[] | null;
  audio?: MessageAudio | null;
  created_at: number;
  archived?: boolean;
  /** Токены сообщения (без reasoning_content) — локальный подсчёт бэкенда. */
  token_count?: number;
  /** Токены reasoning_content (только для assistant). */
  reasoning_tokens?: number;
};

export type ChatInfo = {
  id: number;
  title: string;
  created_at: number;
};

export async function getChats(): Promise<{ chats: ChatInfo[]; active_chat_id: number | null }> {
  return apiFetch('/api/v1/chats');
}

export type ChatSearchResult = {
  chat_id: number;
  chat_title: string;
  snippet: string;
  rank: number;
};

export async function searchChats(query: string, limit = 20): Promise<{ results: ChatSearchResult[] }> {
  return apiFetch(`/api/v1/chats/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export async function createChat(title?: string): Promise<{ chat_id: number }> {
  return apiFetch('/api/v1/chats', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export async function activateChat(chatId: number): Promise<{ ok: boolean; active_chat_id: number }> {
  return apiFetch(`/api/v1/chats/${chatId}/activate`, { method: 'POST' });
}

export async function renameChat(chatId: number, title: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/chats/${chatId}/rename`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });
}

export async function deleteChat(chatId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/chats/${chatId}`, { method: 'DELETE' });
}

export async function getMessages(chatId: number, limit = 50, offset = 0): Promise<{ messages: Message[] }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages?limit=${limit}&offset=${offset}`);
}

export async function deleteMessage(chatId: number, messageId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages/${messageId}`, { method: 'DELETE' });
}

export type ChatMediaItem = {
  message_id: number;
  url: string;
  type: 'user_photo' | 'generated';
  created_at: number;
};

export async function getChatMedia(chatId: number, limit = 100, offset = 0): Promise<{ media: ChatMediaItem[] }> {
  return apiFetch(`/api/v1/chats/${chatId}/media?limit=${limit}&offset=${offset}`);
}

export function resolveImageUrl(url: string): string {
  if (!url.startsWith('/')) return url;
  const tokens = loadTokens();
  const separator = url.includes('?') ? '&' : '?';
  const authParam = tokens?.access_token ? `${separator}token=${tokens.access_token}` : '';
  return `${API_BASE}${url}${authParam}`;
}

export async function sendMessageToTelegram(messageId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/messages/${messageId}/send-to-telegram`, { method: 'POST' });
}

export type ChatSendImage = {
  base64: string;
  mime_type: string;
};

export type DisplayStatePayload = {
  mode?: 'face' | 'media';
  base_mood?: string;
  reactions?: string[];
  media_url?: string;
  loop_reaction?: string;
  clear_loop?: boolean;
};

export type GeneratedImage = {
  image_base64: string;
  image_url?: string;
  prompt_used: string;
};

export type ChatSendResponse = {
  reply_text: string;
  reasoning_content?: string | null;
  message_id: number;
  user_message_id?: number;
  chat_id: number;
  generated_images?: GeneratedImage[];
  display_state?: DisplayStatePayload | null;
  model_fallback_notice?: string | null;
  aborted?: boolean;
  tool_calls?: ToolCall[];
  token_count?: number;
  reasoning_tokens?: number;
  /** Токены user-сообщения (если было сохранено новое). */
  user_token_count?: number;
};

export type ChatContextTokens = {
  messages_tokens: number;
  reasoning_tokens: number;
  archived_tokens: number;
  active_messages: number;
  archived_messages: number;
  system_prompt_tokens: number;
};

export async function getChatContextTokens(chatId: number): Promise<ChatContextTokens> {
  return apiFetch(`/api/v1/chats/${chatId}/context-tokens`);
}

export async function sendChatMessage(text: string, chatId?: number, images?: ChatSendImage[], displayManifest?: { moods: string[]; reactions: string[] }): Promise<ChatSendResponse> {
  const body: Record<string, unknown> = { text };
  if (chatId) body.chat_id = chatId;
  if (images && images.length > 0) body.images = images;
  if (displayManifest) body.display_manifest = displayManifest;
  return apiFetch('/api/v1/chat/send', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------- SSE Streaming (fallback, kept for reference) ----------

export type DesktopActionPayload = {
  action: 'open_widget' | 'close_widget' | 'set_widget_data' | 'open_note' | 'read_widget_state' | 'toggle_panel' | 'execute_macro' | 'suggest_macro' | 'devops_confirmation' | 'suggest_devops_runbook' | 'suggest_server_creds_update' | 'pc_command_confirmation' | 'chat_title_update';
  target?: string;
  value?: { title?: string; content?: string; note_id?: number; macro_name?: string; target_path?: string; description?: string; commands?: string[]; confirmation_id?: string; server_name?: string; server_id?: number; host?: string; command?: string; current_username?: string; new_username?: string; reason?: string; use_ssh_key?: boolean; remove_password?: boolean; chat_id?: number };
};

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

export type MapUpdatePayload = {
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

export type StreamCallbacks = {
  onIntermediate?: (text: string) => void;
  onDisplayState?: (state: DisplayStatePayload) => void;
  onDesktopAction?: (action: DesktopActionPayload) => void;
  onToolStatus?: (text: string) => void;
  onMapUpdate?: (data: MapUpdatePayload) => void;
  onDone?: (result: ChatSendResponse) => void;
  onError?: (err: string) => void;
};

// ---------- WebSocket ----------

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

type WsCallbacks = StreamCallbacks & {
  onConnect?: () => void;
  onDisconnect?: () => void;
};

let wsCallbacks: WsCallbacks = {};

export function initWebSocket(callbacks?: WsCallbacks) {
  if (callbacks) wsCallbacks = callbacks;

  // Already connecting or open — skip
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  const tokens = loadTokens();
  if (!tokens?.access_token) return;

  const wsBase = API_BASE.replace(/^http/, 'ws');
  ws = new WebSocket(`${wsBase}/ws?token=${tokens.access_token}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    wsCallbacks.onConnect?.();
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string);

      switch (msg.type) {
        case 'intermediate': wsCallbacks.onIntermediate?.(msg.text); break;
        case 'display_state': wsCallbacks.onDisplayState?.(msg); break;
        case 'desktop_action':
          // If it's a macro — execute it via Electron in the background
          if (msg.action === 'execute_macro' && msg.value?.commands) {
            (window as any).electronAPI?.executeCommands(msg.value.commands).catch(console.error);
          }
          // Pass to React (e.g. UI toast "Macro launched")
          wsCallbacks.onDesktopAction?.(msg);
          break;
        case 'tool_status': wsCallbacks.onToolStatus?.(msg.text); break;
        case 'map_update': wsCallbacks.onMapUpdate?.(msg); break;
        case 'done': wsCallbacks.onDone?.(msg); break;
        case 'error': wsCallbacks.onError?.(msg.error); break;
        case 'execute_ipc':
          console.log('[ws] execute_ipc received', {
            requestId: msg.request_id,
            ipcType: msg.ipc_type,
            payloadPreview: JSON.stringify(msg.payload).slice(0, 500),
          });
          handleExecuteIpc(msg);
          break;
        case 'pong': break;
      }
    } catch { /* ignore malformed JSON */ }
  };

  ws.onclose = (ev) => {
    ws = null;
    wsCallbacks.onDisconnect?.();

    // Auto-reconnect if not intentional close and not replaced by a newer connection
    if (ev.code !== 1000 && ev.code !== 4002) {
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        initWebSocket();
      }, reconnectDelay);
    }
  };

  ws.onerror = () => { /* onclose will fire */ };
}

export function closeWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close(1000);
  ws = null;
}

export function reconnectWebSocket() {
  closeWebSocket();
  reconnectDelay = 1000;
  initWebSocket();
}

export function isWsConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

// ── Send chat_send via WS ──

export async function streamChatMessage(
  text: string,
  chatId?: number,
  images?: ChatSendImage[],
  displayManifest?: { moods: string[]; reactions: string[] },
  callbacks?: StreamCallbacks,
  options?: { isVoice?: boolean; preferredModel?: string | null; regenerate_hint?: string; skip_user_history?: boolean; regenerate_from_history?: boolean }
) {
  // Update callbacks for this request
  if (callbacks) {
    wsCallbacks = { ...wsCallbacks, ...callbacks };
  }

  // If WS is connected — send through WS
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg: Record<string, unknown> = { type: 'chat_send', text };
    if (chatId) msg.chat_id = chatId;
    if (images?.length) msg.images = images;
    if (displayManifest) msg.display_manifest = displayManifest;
    if (options?.isVoice) msg.is_voice = true;
    if (options?.preferredModel) msg.preferred_model = options.preferredModel;
    if (options?.regenerate_hint) msg.regenerate_hint = options.regenerate_hint;
    if (options?.skip_user_history) msg.skip_user_history = true;
    if (options?.regenerate_from_history) msg.regenerate_from_history = true;
    ws.send(JSON.stringify(msg));
    return;
  }

  // Fallback: SSE
  await streamChatMessageSSE(text, chatId, images, displayManifest, callbacks, options);
}

// ── Stop chat generation ──

export function stopChatStream() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat_stop' }));
  }
  // POST is also used as a fallback/backup for WS stop.
  const tokens = loadTokens();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tokens?.access_token) headers['Authorization'] = `Bearer ${tokens.access_token}`;
  fetch(`${API_BASE}/api/v1/chat/stop`, { method: 'POST', headers }).catch(() => {});
}

// ── SSE fallback (kept for when WS is not connected) ──

async function streamChatMessageSSE(
  text: string,
  chatId?: number,
  images?: ChatSendImage[],
  displayManifest?: { moods: string[]; reactions: string[] },
  callbacks?: StreamCallbacks,
  options?: { isVoice?: boolean; preferredModel?: string | null; regenerate_hint?: string; skip_user_history?: boolean; regenerate_from_history?: boolean }
) {
  const attemptStream = async (isRetry = false): Promise<void> => {
    const tokens = loadTokens();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokens?.access_token) headers['Authorization'] = `Bearer ${tokens.access_token}`;

    const body: Record<string, unknown> = { text, is_desktop: true };
    if (chatId) body.chat_id = chatId;
    if (images && images.length > 0) body.images = images;
    if (displayManifest) body.display_manifest = displayManifest;
    if (options?.isVoice) body.is_voice = true;
    if (options?.preferredModel) body.preferred_model = options.preferredModel;
    if (options?.regenerate_hint) body.regenerate_hint = options.regenerate_hint;
    if (options?.skip_user_history) body.skip_user_history = true;
    if (options?.regenerate_from_history) body.regenerate_from_history = true;

    const res = await fetch(`${API_BASE}/api/v1/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 401 && !isRetry && tokens?.refresh_token) {
      const refreshed = await refreshToken(tokens.refresh_token);
      if (refreshed) {
        saveTokens(refreshed);
        return attemptStream(true);
      }
      clearTokens();
      throw new Error('Session expired');
    }

    if (!res.ok) throw new Error(await res.text());
    if (!res.body) throw new Error('ReadableStream not supported');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        if (!chunk.trim() || chunk.startsWith(':')) continue;

        const lines = chunk.split('\n');
        let eventName = 'message';
        let dataStr = '';

        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataStr = line.slice(5).trim();
        }

        if (dataStr) {
          try {
            const data = JSON.parse(dataStr);
            if (eventName === 'intermediate' && callbacks?.onIntermediate) callbacks.onIntermediate(data.text);
            else if (eventName === 'display_state' && callbacks?.onDisplayState) callbacks.onDisplayState(data);
            else if (eventName === 'desktop_action' && callbacks?.onDesktopAction) callbacks.onDesktopAction(data);
            else if (eventName === 'map_update' && callbacks?.onMapUpdate) callbacks.onMapUpdate(data);
            else if (eventName === 'tool_status' && callbacks?.onToolStatus) callbacks.onToolStatus(data.text);
            else if (eventName === 'done' && callbacks?.onDone) callbacks.onDone(data);
            else if (eventName === 'error' && callbacks?.onError) callbacks.onError(data.error);
          } catch {
            // ignore malformed JSON
          }
        }
      }
    }
  };

  try {
    await attemptStream();
  } catch (err: any) {
    if (callbacks?.onError) callbacks.onError(err.message || 'stream_failed');
  }
}

// ── Handle execute_ipc from server ──

async function handleExecuteIpc(msg: { request_id: string; ipc_type: string; payload: any }) {
  const { request_id, ipc_type, payload } = msg;

  try {
    let result: any;
    console.log('[ipc] renderer start', {
      requestId: request_id,
      ipcType: ipc_type,
      payloadPreview: JSON.stringify(payload).slice(0, 500),
      hasElectronApi: Boolean((window as any).electronAPI),
    });

    if (ipc_type === 'execute_commands') {
      console.log('[ipc] renderer invoke executeCommands', {
        requestId: request_id,
        commands: Array.isArray(payload.commands) ? payload.commands : undefined,
      });
      result = await (window as any).electronAPI?.executeCommands(payload.commands);
    } else if (ipc_type === 'read_directory') {
      console.log('[ipc] renderer invoke readDirectory', {
        requestId: request_id,
        targetPath: payload.target_path,
      });
      result = await (window as any).electronAPI?.readDirectory(payload.target_path);
    } else if (ipc_type === 'capture_screen') {
      console.log('[ipc] renderer invoke captureScreen', { requestId: request_id });
      result = await (window as any).electronAPI?.captureScreen();
    } else if (ipc_type === 'visual_click') {
      console.log('[ipc] renderer invoke visualClick', {
        requestId: request_id,
        payload,
      });
      result = await (window as any).electronAPI?.visualClick(payload);
    } else {
      throw new Error(`unknown ipc_type: ${ipc_type}`);
    }

    console.log('[ipc] renderer result', {
      requestId: request_id,
      resultType: typeof result,
      resultPreview: typeof result === 'string' ? result.slice(0, 500) : undefined,
      wsReadyState: ws?.readyState,
    });
    ws?.send(JSON.stringify({ type: 'ipc_result', request_id, data: result }));
    console.log('[ipc] renderer ipc_result sent', { requestId: request_id });
  } catch (err: any) {
    console.error('[ipc] renderer error', {
      requestId: request_id,
      ipcType: ipc_type,
      error: err?.message || String(err),
      wsReadyState: ws?.readyState,
    });
    ws?.send(JSON.stringify({ type: 'ipc_result', request_id, error: err?.message || String(err) }));
    console.log('[ipc] renderer ipc_result error sent', { requestId: request_id });
  }
}

// ---------- Telegram Link ----------

export type LinkGenerateResponse = {
  code: string;
  expires_in: number;
};

export type LinkStatusResponse = {
  linked: boolean;
  tg_username?: string;
  pending_code?: string;
  expires_in?: number;
};

export async function generateLinkCodeApi(): Promise<LinkGenerateResponse> {
  return apiFetch('/api/v1/link/generate', { method: 'POST' });
}

export async function getLinkStatus(): Promise<LinkStatusResponse> {
  return apiFetch('/api/v1/link/status');
}

export async function unlinkTelegram(): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/link/unlink', { method: 'POST' });
}

// ---------- Prompts ----------

export type PromptInfo = {
  id: number;
  name: string;
  description: string;
  is_default: number;
};

export type PromptsResponse = {
  prompts: PromptInfo[];
  selected_prompt_id: number | null;
  custom_prompt_content: string | null;
};

export async function getPrompts(): Promise<PromptsResponse> {
  return apiFetch('/api/v1/prompts');
}

export async function selectPrompt(promptId: number): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/prompts/select', {
    method: 'POST',
    body: JSON.stringify({ prompt_id: promptId }),
  });
}

export async function updateCustomPrompt(content: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/prompts/custom', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

// ---------- Notes ----------

export type NoteDto = {
  id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
};

export async function listNotes(limit = 20, offset = 0, query = ''): Promise<{ notes: NoteDto[]; total: number }> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (query.trim()) params.set('query', query.trim());
  return apiFetch(`/api/v1/notes?${params.toString()}`);
}

export async function getNoteById(noteId: number): Promise<{ note: NoteDto }> {
  return apiFetch(`/api/v1/notes/${noteId}`);
}

export async function createNote(title: string, content: string): Promise<{ note_id?: number; error?: string }> {
  return apiFetch('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify({ title, content }),
  });
}

export async function deleteNote(noteId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/notes/${noteId}`, { method: 'DELETE' });
}

// ---------- Tasks ----------

export type TaskType = 'message' | 'smart_home' | 'web_search' | 'email_check' | 'ai_instruction';
export type TaskStatus = 'pending' | 'done' | 'error';
export type TaskRecurrenceType = 'once' | 'daily' | 'weekly';

export type TaskDto = {
  id: number;
  execute_at: number;
  task_type: TaskType;
  payload: string;
  status: TaskStatus;
  recurrence_type: TaskRecurrenceType;
  recurrence_weekday: number | null;
  timezone_offset: number | null;
};

export async function listTasks(limit = 50, status: 'pending' | 'done' | 'error' | 'all' = 'pending'): Promise<{ tasks: TaskDto[] }> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('status', status);
  return apiFetch(`/api/v1/tasks?${params.toString()}`);
}

export async function deleteTask(taskId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/tasks/${taskId}`, { method: 'DELETE' });
}

// ---------- Map Pins ----------

export type MapPinDto = {
  id: number;
  lat: number;
  lng: number;
  label: string;
  created_at: number;
  updated_at: number;
};

export async function listMapPins(): Promise<{ pins: MapPinDto[] }> {
  return apiFetch('/api/v1/map-pins');
}

export async function createMapPin(lat: number, lng: number, label = ''): Promise<{ pin_id: number }> {
  return apiFetch('/api/v1/map-pins', {
    method: 'POST',
    body: JSON.stringify({ lat, lng, label }),
  });
}

export async function updateMapPin(pinId: number, updates: { lat?: number; lng?: number; label?: string }): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/map-pins/${pinId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteMapPin(pinId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/map-pins/${pinId}`, { method: 'DELETE' });
}

// ── Models ──

export type ModelCatalogEntry = {
  id: string;
  name: string;
  description: string;
  reasoning_levels?: ReasoningLevel[] | null;
  supported_params?: string[];
};

export async function getModels(): Promise<{ models: ModelCatalogEntry[]; preferred_model: string | null; auto_reasoning_levels?: ReasoningLevel[] }> {
  return apiFetch('/api/v1/models');
}

export async function setPreferredModel(modelId: string | null): Promise<{ ok: boolean; preferred_model: string | null }> {
  return apiFetch('/api/v1/user/preferred-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId }),
  });
}

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export async function getReasoningLevel(): Promise<{ reasoning_level: ReasoningLevel | null }> {
  return apiFetch('/api/v1/user/reasoning-level');
}

export async function setReasoningLevel(level: ReasoningLevel | null): Promise<{ ok: boolean; reasoning_level: ReasoningLevel | null }> {
  return apiFetch('/api/v1/user/reasoning-level', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reasoning_level: level }),
  });
}

// ---------- Model settings (temperature, penalties, etc.) ----------

/**
 * Per-model generation settings.
 * Каждое поле опционально: null/undefined = использовать серверный дефолт.
 */
export type ModelSettings = {
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  repetition_penalty?: number | null;
  max_tokens?: number | null;
};

/** Map: modelId → settings */
export type ModelSettingsMap = Record<string, ModelSettings>;

export async function getModelSettings(): Promise<{ model_settings: ModelSettingsMap }> {
  return apiFetch('/api/v1/user/model-settings');
}

export async function setModelSettings(modelId: string, settings: ModelSettings): Promise<{ ok: boolean; model_settings: ModelSettingsMap }> {
  return apiFetch('/api/v1/user/model-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId, settings }),
  });
}

export async function deleteModelSettings(modelId: string): Promise<{ ok: boolean; model_settings: ModelSettingsMap }> {
  return apiFetch(`/api/v1/user/model-settings/${encodeURIComponent(modelId)}`, {
    method: 'DELETE',
  });
}

// ---------- Feature flags (tool restrictions) ----------

export type FeatureFlags = {
  disable_memory_write: boolean;
  disable_pc_control_lite: boolean;
  disable_pc_control_full: boolean;
  disable_pc_commands: boolean;
  disable_internet: boolean;
  disable_personal: boolean;
  disable_subagents: boolean;
};

export async function getFeatureFlags(): Promise<{ flags: FeatureFlags }> {
  return apiFetch('/api/v1/user/feature-flags');
}

export async function setFeatureFlags(flags: Partial<FeatureFlags>): Promise<{ ok: boolean; flags: FeatureFlags }> {
  return apiFetch('/api/v1/user/feature-flags', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flags }),
  });
}

// ---------- TTS (Cartesia cloud) ----------

export type CartesiaVoice = {
  id: string;
  name: string;
  description?: string;
  language?: string;
  gender?: string;
};

export async function fetchTtsVoices(language?: string): Promise<{ voices: CartesiaVoice[] }> {
  const query = language ? `?language=${encodeURIComponent(language)}` : '';
  return apiFetch(`/api/v1/tts/voices${query}`);
}

export async function fetchTtsVoicePreview(voiceId: string, language: string = 'ru'): Promise<{ audio_url: string }> {
  return apiFetch(`/api/v1/tts/preview?voice_id=${encodeURIComponent(voiceId)}&language=${encodeURIComponent(language)}`);
}

export type TtsGenerateResponse = {
  audio_url: string;
  tts_type: string;
  voice_id: string;
};

export async function generateTts(
  text: string,
  voiceId: string,
  language: string = 'ru',
  messageId?: number,
): Promise<TtsGenerateResponse> {
  const body: Record<string, unknown> = { text, voice_id: voiceId, language };
  if (messageId) body.message_id = messageId;
  return apiFetch('/api/v1/tts/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Download audio file from server as ArrayBuffer.
 * Uses ?token= query param for auth (same pattern as images).
 */
export async function fetchAudioBuffer(audioUrl: string): Promise<ArrayBuffer> {
  const tokens = loadTokens();
  const token = tokens?.access_token || '';
  const separator = audioUrl.includes('?') ? '&' : '?';
  const res = await fetch(`${API_BASE}${audioUrl}${separator}token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`Audio fetch failed: ${res.status}`);
  return res.arrayBuffer();
}
