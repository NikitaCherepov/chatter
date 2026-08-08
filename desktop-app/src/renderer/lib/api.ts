const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3050';
const CONNECTION_KEY = 'chatter_server_connection';

export type ServerConnection = { apiBase: string; key: string };

export function loadServerConnection(): ServerConnection | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONNECTION_KEY) || 'null') as ServerConnection | null;
    return parsed?.apiBase && parsed?.key ? parsed : null;
  } catch { return null; }
}

export let API_BASE: string = loadServerConnection()?.apiBase || DEFAULT_API_BASE;

export async function configureServerConnection(connectionLink: string) {
  const parsed = new URL(connectionLink.trim());
  if (parsed.protocol !== 'chatter:') throw new Error('invalid_connection_link');
  const server = `${parsed.searchParams.get('server') || ''}`.trim().replace(/\/+$/, '');
  const key = `${parsed.searchParams.get('key') || ''}`.trim();
  const serverUrl = new URL(server);
  if (!['http:', 'https:'].includes(serverUrl.protocol) || !key) throw new Error('invalid_connection_link');
  const authorization = await window.electronAPI.authorizeServer(server, key, true);
  const connection = { apiBase: authorization.apiBase, key };
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
  API_BASE = authorization.apiBase;
  return { connection, reloadRequired: authorization.reloadRequired };
}

export async function ensureServerSecurityPolicy(): Promise<boolean> {
  const connection = loadServerConnection();
  if (!connection) return false;
  const authorization = await window.electronAPI.authorizeServer(connection.apiBase, connection.key);
  if (authorization.apiBase !== connection.apiBase) {
    const normalized = { ...connection, apiBase: authorization.apiBase };
    localStorage.setItem(CONNECTION_KEY, JSON.stringify(normalized));
    API_BASE = authorization.apiBase;
  }
  return authorization.reloadRequired;
}

export async function clearServerConnection() {
  await window.electronAPI.clearTrustedServer();
  localStorage.removeItem(CONNECTION_KEY);
  clearTokens();
  API_BASE = DEFAULT_API_BASE;
}

type Tokens = {
  access_token: string;
  refresh_token: string;
  access_expires_in: number;
  refresh_expires_in: number;
};

export type UiSettings = {
  show_tokens?: boolean;
  dice_roll_enabled?: boolean;
  seen_announcements?: string[];
};

type User = {
  id: number;
  name: string | null;
  username: string | null;
  role: string;
  is_admin: number;
  plan: string;
  image_attachments_allowed: boolean;
  max_image_attachments_per_request: number;
  max_image_attachments_total_bytes: number;
  selected_prompt_id: number | null;
  custom_prompt_content: string | null;
  core_memory: string | null;
  language?: string | null;
  ui_settings?: UiSettings;
  subagent_model?: string | null;
  subagent_reasoning_level?: ReasoningLevel | null;
  telegram_linked?: boolean;
  must_change_password?: boolean;
  identities?: Array<{
    provider: string;
    provider_subject: string;
    username: string | null;
  }>;
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
  const connection = loadServerConnection();
  if (connection?.key) headers['X-Chatter-Server-Key'] = connection.key;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  const refreshExcludedPaths = new Set([
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/refresh',
  ]);

  if (res.status === 401 && tokens?.refresh_token && !refreshExcludedPaths.has(path)) {
    const refreshed = await refreshToken(tokens.refresh_token);
    if (refreshed) {
      saveTokens(refreshed);
      // Reconnect WebSocket with new token
      reconnectWebSocket();
      headers['Authorization'] = `Bearer ${refreshed.access_token}`;
      const retry = await fetch(`${API_BASE}${path}`, { ...options, headers });
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        if (retry.status === 401) clearTokens();
        throw new ApiError(retry.status, body.error || 'unknown_error', body);
      }
      return retry.json();
    }
    clearTokens();
    throw new ApiError(401, 'session_expired');
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

/** Prefer a localized message returned by the backend, then fall back to UI text. */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && typeof error.body?.message === 'string' && error.body.message.trim()) {
    return error.body.message.trim();
  }
  return fallback;
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
    const connection = loadServerConnection();
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(connection?.key ? { 'X-Chatter-Server-Key': connection.key } : {}) },
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

export type MessageAttachment = {
  name: string;
  size_bytes: number;
  mime_type: string;
  extracted_text: string;
  url: string;
  filename: string;
};

export type MessageAudio = {
  url: string;
  tts_type: string;
  voice_id: string;
};

export type NormalizedTokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  reasoning_tokens: number;
};

export type TokenUsageCall = NormalizedTokenUsage & {
  model: string;
  provider: string;
  uniqueId?: string | null;
};

export type MessageUsage = {
  latest: NormalizedTokenUsage;
  aggregate: NormalizedTokenUsage;
  calls: TokenUsageCall[];
  context_estimate_tokens?: number;
  context_local_tokens?: number;
};

export type ToolCall = { id?: string; name: string; arguments: any; result_preview?: string };

/** Полный trace ad-hoc субагента — для UI-блока «Сабагенты». */
export type SubagentIteration = {
  step: number;
  content: string;
  tool_calls: Array<{ id?: string; name: string; arguments: any }>;
  results: Array<{ id?: string; name: string; content: string }>;
  is_final?: boolean;
};

export type SubagentTrace = {
  task: string;
  system_prompt: string;
  tools: string[];
  tools_used: string[];
  answer: string;
  summary: string;
  aborted?: boolean;
  usage?: MessageUsage | null;
  iterations: SubagentIteration[];
};

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
  prompt_name?: string | null;
  model_name?: string | null;
  provider_name?: string | null;
  usage?: MessageUsage | null;
  attachments?: MessageAttachment[] | null;
  /** Полные trace ad-hoc субагентов (если были). */
  subagents?: SubagentTrace[] | null;
};

export type ChatInfo = {
  id: number;
  title: string;
  created_at: number;
  bot_hidden?: boolean;
};

export async function getChats(limit = 25, offset = 0): Promise<{ chats: ChatInfo[]; active_chat_id: number | null }> {
  return apiFetch(`/api/v1/chats?limit=${limit}&offset=${offset}`);
}

export type ChatSearchResult = {
  chat_id: number;
  chat_title: string;
  created_at: number;
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

export async function forkChatFromMessage(
  sourceChatId: number,
  fromMessageId: number,
  title?: string
): Promise<{ chat_id: number; forked_messages: number }> {
  return apiFetch(`/api/v1/chats/${sourceChatId}/fork`, {
    method: 'POST',
    body: JSON.stringify({ from_message_id: fromMessageId, title }),
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

export async function setChatBotHidden(chatId: number, hidden: boolean): Promise<{ ok: boolean; bot_hidden: boolean }> {
  return apiFetch(`/api/v1/chats/${chatId}/bot-hidden`, {
    method: 'PUT',
    body: JSON.stringify({ hidden }),
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

export async function editMessage(chatId: number, messageId: number, content: string): Promise<{ ok: boolean; token_count: number }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages/${messageId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export type ChatMediaItem = {
  message_id: number;
  url: string;
  type: 'user_photo' | 'generated';
  created_at: number;
  chat_id?: number;
  chat_title?: string;
};

export async function getChatMedia(chatId: number, limit = 100, offset = 0): Promise<{ media: ChatMediaItem[] }> {
  return apiFetch(`/api/v1/chats/${chatId}/media?limit=${limit}&offset=${offset}`);
}

export async function getAllMedia(limit = 100, offset = 0): Promise<{ media: ChatMediaItem[] }> {
  return apiFetch(`/api/v1/media/all?limit=${limit}&offset=${offset}`);
}

export function resolveImageUrl(url: string, thumbnailWidth?: number): string {
  if (!url.startsWith('/')) return url;
  const tokens = loadTokens();
  const params = new URLSearchParams();
  if (tokens?.access_token) params.set('token', tokens.access_token);
  if (thumbnailWidth && thumbnailWidth > 0) params.set('w', String(thumbnailWidth));
  const qs = params.toString();
  return `${API_BASE}${url}${qs ? `?${qs}` : ''}`;
}

export async function sendMessageToTelegram(messageId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/messages/${messageId}/send-to-telegram`, { method: 'POST' });
}

export type ChatSendImage = {
  base64: string;
  mime_type: string;
};

export type ChatSendDocument = {
  base64: string;
  filename: string;
  mime_type?: string;
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
  user_message_images?: MessageImage[];
  chat_id: number;
  generated_images?: GeneratedImage[];
  display_state?: DisplayStatePayload | null;
  model_fallback_notice?: string | null;
  aborted?: boolean;
  tool_calls?: ToolCall[];
  token_count?: number;
  reasoning_tokens?: number;
  prompt_name?: string | null;
  model_name?: string | null;
  provider_name?: string | null;
  message_usage?: MessageUsage | null;
  usage?: {
    tokens_used: number;
    used_model: string;
    used_provider: string;
    prompt_tokens: number;
    completion_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
    reasoning_tokens: number;
    calls: TokenUsageCall[];
  };
  /** Токены user-сообщения (если было сохранено новое). */
  user_token_count?: number;
  /** Результат броска d20 (1..20) в режиме Dice Roll Mode, иначе отсутствует. */
  dice_roll?: number;
  /** Полные trace ad-hoc субагентов (для UI-блока «Сабагенты»). */
  subagents?: SubagentTrace[];
};

export type ChatContextTokens = {
  messages_tokens: number;
  reasoning_tokens: number;
  archived_tokens: number;
  active_messages: number;
  archived_messages: number;
  system_prompt_tokens: number;
  latest_prompt_tokens: number;
  latest_completion_tokens: number;
  latest_total_tokens: number;
  latest_cache_hit_tokens: number;
  latest_cache_miss_tokens: number;
  latest_reasoning_tokens: number;
  latest_model_name: string | null;
  current_context_tokens: number;
};

export async function getChatContextTokens(chatId: number): Promise<ChatContextTokens> {
  return apiFetch(`/api/v1/chats/${chatId}/context-tokens`);
}

export async function sendChatMessage(text: string, chatId?: number, images?: ChatSendImage[], displayManifest?: { moods: string[]; reactions: string[] }, currentDisplayState?: DisplayStatePayload | null): Promise<ChatSendResponse> {
  const body: Record<string, unknown> = { text };
  if (chatId) body.chat_id = chatId;
  if (images && images.length > 0) body.images = images;
  if (displayManifest) body.display_manifest = displayManifest;
  if (currentDisplayState) body.current_display_state = currentDisplayState;
  return apiFetch('/api/v1/chat/send', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------- SSE Streaming (fallback, kept for reference) ----------

export type DesktopActionPayload = {
  action: 'open_widget' | 'close_widget' | 'set_widget_data' | 'open_note' | 'read_widget_state' | 'toggle_panel' | 'execute_macro' | 'suggest_macro' | 'devops_confirmation' | 'suggest_devops_runbook' | 'suggest_server_creds_update' | 'pc_command_confirmation' | 'browser_action_confirmation' | 'browser_action_confirmation_resolved' | 'file_action_confirmation' | 'edit_file_lines_confirmation' | 'email_confirmation' | 'chat_title_update' | 'webcam_capture_confirmation' | 'suggest_chat_link';
  target?: string;
  value?: { title?: string; content?: string; note_id?: number; macro_name?: string; target_path?: string; description?: string; commands?: string[]; confirmation_id?: string; server_name?: string; server_id?: number; host?: string; command?: string; current_username?: string; new_username?: string; reason?: string; use_ssh_key?: boolean; remove_password?: boolean; chat_id?: number; from?: string; to?: string; subject?: string; body?: string; purpose?: string; camera_name?: string };
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
  onDiceRoll?: (roll: number) => void;
  onUserMessageSaved?: (data: { message_id: number; images?: MessageImage[] }) => void;
  /** Стрим текстовых токенов от модели в реальном времени (оттроттлено бэкендом). */
  onStreamToken?: (text: string) => void;
  /** Стрим reasoning-токенов в реальном времени. */
  onReasoningStream?: (text: string) => void;
  onDone?: (result: ChatSendResponse) => void;
  onError?: (err: string, message?: string) => void;
};

// ---------- WebSocket ----------

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsTokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let wsAuthRefreshAckTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let wsTokenRefreshPromise: Promise<boolean> | null = null;

type WsCallbacks = StreamCallbacks & {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onTaskResult?: (data: { chat_id: number; text: string; is_new_chat: boolean }) => void;
  onChatUpdated?: (data: {
    chat_id: number;
    message_id: number;
    phase: 'user' | 'assistant';
  }) => void;
};

let wsCallbacks: WsCallbacks = {};
let activeStreamCallbacks: StreamCallbacks = {};
let activeChatRequestAccepted = false;

const failActiveChatRequest = (error: string, message?: string) => {
  const callback = activeStreamCallbacks.onError ?? wsCallbacks.onError;
  activeStreamCallbacks = {};
  activeChatRequestAccepted = false;
  callback?.(error, message);
};

const refreshWebSocketAccessToken = (): Promise<boolean> => {
  if (wsTokenRefreshPromise) return wsTokenRefreshPromise;

  wsTokenRefreshPromise = (async () => {
    const tokens = loadTokens();
    if (!tokens?.refresh_token) return false;
    const refreshTokenUsed = tokens.refresh_token;

    const refreshed = await refreshToken(refreshTokenUsed);
    if (!refreshed) return false;

    // The user may have logged out or another request may already have rotated
    // the stored token while this refresh was in flight.
    if (loadTokens()?.refresh_token !== refreshTokenUsed) return false;

    saveTokens(refreshed);
    return true;
  })().finally(() => {
    wsTokenRefreshPromise = null;
  });

  return wsTokenRefreshPromise;
};

const getAccessTokenTiming = (token: string): { issuedAtMs: number; expiresAtMs: number } | null => {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as { iat?: number; exp?: number };
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
    return {
      issuedAtMs: Number(payload.iat) * 1000,
      expiresAtMs: Number(payload.exp) * 1000,
    };
  } catch {
    return null;
  }
};

const scheduleWebSocketTokenRefresh = (socket: WebSocket) => {
  if (wsTokenRefreshTimer) clearTimeout(wsTokenRefreshTimer);
  wsTokenRefreshTimer = null;

  const accessToken = loadTokens()?.access_token;
  const timing = accessToken ? getAccessTokenTiming(accessToken) : null;
  if (!timing) return;

  const tokenLifetimeMs = Math.max(0, timing.expiresAtMs - timing.issuedAtMs);
  const refreshAheadMs = Math.min(60_000, Math.max(5_000, tokenLifetimeMs * 0.1));
  const delayMs = Math.max(1_000, timing.expiresAtMs - Date.now() - refreshAheadMs);

  wsTokenRefreshTimer = setTimeout(() => {
    wsTokenRefreshTimer = null;
    void refreshWebSocketAccessToken().then((refreshed) => {
      if (ws !== socket) return;
      if (refreshed) {
        const accessToken = loadTokens()?.access_token;
        if (!accessToken || socket.readyState !== WebSocket.OPEN) {
          reconnectWebSocket();
          return;
        }

        try {
          socket.send(JSON.stringify({ type: 'auth_refresh', token: accessToken }));
          if (wsAuthRefreshAckTimer) clearTimeout(wsAuthRefreshAckTimer);
          wsAuthRefreshAckTimer = setTimeout(() => {
            wsAuthRefreshAckTimer = null;
            if (ws === socket) reconnectWebSocket();
          }, 10_000);
        } catch {
          reconnectWebSocket();
        }
        return;
      }

      // A temporary refresh failure should not immediately kill a still-valid socket.
      wsTokenRefreshTimer = setTimeout(() => {
        wsTokenRefreshTimer = null;
        if (ws === socket) scheduleWebSocketTokenRefresh(socket);
      }, 10_000);
    });
  }, delayMs);
};

/** Register a global handler for task_result events (scheduler push). */
export function onTaskResult(cb: WsCallbacks['onTaskResult']) {
  wsCallbacks.onTaskResult = cb;
}

/** Register a handler for messages added to a chat by another client, such as Telegram. */
export function onChatUpdated(cb: NonNullable<WsCallbacks['onChatUpdated']>) {
  wsCallbacks.onChatUpdated = cb;
  return () => {
    if (wsCallbacks.onChatUpdated === cb) {
      wsCallbacks.onChatUpdated = undefined;
    }
  };
}

/** Register a persistent handler for desktop actions that may arrive after a chat request has finished. */
export function onDesktopAction(cb: StreamCallbacks['onDesktopAction']) {
  wsCallbacks.onDesktopAction = cb;
  return () => {
    if (wsCallbacks.onDesktopAction === cb) {
      wsCallbacks.onDesktopAction = undefined;
    }
  };
}

/** Register a persistent handler for map updates initiated outside the desktop chat. */
export function onMapUpdate(cb: StreamCallbacks['onMapUpdate']) {
  wsCallbacks.onMapUpdate = cb;
  return () => {
    if (wsCallbacks.onMapUpdate === cb) {
      wsCallbacks.onMapUpdate = undefined;
    }
  };
}

export function initWebSocket(callbacks?: WsCallbacks) {
  if (callbacks) wsCallbacks = { ...wsCallbacks, ...callbacks };

  // Already connecting or open — skip
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  const tokens = loadTokens();
  if (!tokens?.access_token) return;

  const wsBase = API_BASE.replace(/^http/, 'ws');
  const socket = new WebSocket(`${wsBase}/ws?token=${tokens.access_token}`);
  ws = socket;

  socket.onopen = () => {
    reconnectDelay = 1000;
    console.log('[ws] connected');
    scheduleWebSocketTokenRefresh(socket);
    wsCallbacks.onConnect?.();
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string);

      switch (msg.type) {
        case 'chat_accepted':
          activeChatRequestAccepted = true;
          break;
        case 'intermediate': (activeStreamCallbacks.onIntermediate ?? wsCallbacks.onIntermediate)?.(msg.text); break;
        case 'stream_token': (activeStreamCallbacks.onStreamToken ?? wsCallbacks.onStreamToken)?.(msg.text); break;
        case 'reasoning_token': (activeStreamCallbacks.onReasoningStream ?? wsCallbacks.onReasoningStream)?.(msg.text); break;
        case 'display_state': (activeStreamCallbacks.onDisplayState ?? wsCallbacks.onDisplayState)?.(msg); break;
        case 'desktop_action':
          // If it's a macro — execute it via Electron in the background
          if (msg.action === 'execute_macro' && msg.value?.commands) {
            (window as any).electronAPI?.executeCommands(msg.value.commands).catch(console.error);
          }
          // Pass to React (e.g. UI toast "Macro launched")
          (activeStreamCallbacks.onDesktopAction ?? wsCallbacks.onDesktopAction)?.(msg);
          break;
        case 'tool_status': (activeStreamCallbacks.onToolStatus ?? wsCallbacks.onToolStatus)?.(msg.text); break;
        case 'map_update': (activeStreamCallbacks.onMapUpdate ?? wsCallbacks.onMapUpdate)?.(msg); break;
        case 'dice_roll': (activeStreamCallbacks.onDiceRoll ?? wsCallbacks.onDiceRoll)?.(Number(msg.roll)); break;
        case 'user_message_saved': (activeStreamCallbacks.onUserMessageSaved ?? wsCallbacks.onUserMessageSaved)?.(msg); break;
        case 'done': {
          (activeStreamCallbacks.onDone ?? wsCallbacks.onDone)?.(msg);
          activeStreamCallbacks = {};
          activeChatRequestAccepted = false;
          break;
        }
        case 'error': {
          (activeStreamCallbacks.onError ?? wsCallbacks.onError)?.(msg.error, msg.message);
          activeStreamCallbacks = {};
          activeChatRequestAccepted = false;
          break;
        }
        case 'task_result': wsCallbacks.onTaskResult?.({ chat_id: msg.chat_id, text: msg.text, is_new_chat: msg.is_new_chat }); break;
        case 'chat_updated':
          wsCallbacks.onChatUpdated?.({
            chat_id: Number(msg.chat_id),
            message_id: Number(msg.message_id),
            phase: msg.phase === 'assistant' ? 'assistant' : 'user',
          });
          break;
        case 'auth_refreshed':
          if (wsAuthRefreshAckTimer) clearTimeout(wsAuthRefreshAckTimer);
          wsAuthRefreshAckTimer = null;
          scheduleWebSocketTokenRefresh(socket);
          break;
        case 'auth_refresh_required':
          // Server-side init: access token is about to expire (or just expired).
          // Refresh proactively and send the new token without dropping the socket.
          void refreshWebSocketAccessToken().then((refreshed) => {
            if (ws !== socket) return;
            if (!refreshed) {
              reconnectWebSocket();
              return;
            }
            const accessToken = loadTokens()?.access_token;
            if (!accessToken || socket.readyState !== WebSocket.OPEN) {
              reconnectWebSocket();
              return;
            }
            try {
              socket.send(JSON.stringify({ type: 'auth_refresh', token: accessToken }));
              if (wsAuthRefreshAckTimer) clearTimeout(wsAuthRefreshAckTimer);
              wsAuthRefreshAckTimer = setTimeout(() => {
                wsAuthRefreshAckTimer = null;
                if (ws === socket) reconnectWebSocket();
              }, 10_000);
            } catch {
              reconnectWebSocket();
            }
          });
          break;
        case 'execute_ipc':
          console.log('[ws] execute_ipc received', {
            requestId: msg.request_id,
            ipcType: msg.ipc_type,
            payloadPreview: JSON.stringify(msg.payload).slice(0, 500),
          });
          handleExecuteIpc(msg);
          break;
        case 'cancel_ipc':
          console.log('[ws] cancel_ipc received', {
            requestId: msg.request_id,
            ipcType: msg.ipc_type,
            reason: msg.reason,
          });
          if (msg.ipc_type === 'convert_video') {
            (window as any).electronAPI?.cancelVideoConversion(msg.request_id).catch(console.error);
          }
          break;
        case 'ping':
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'pong', t: msg.t || Date.now() }));
          }
          break;
        case 'pong': break;
      }
    } catch { /* ignore malformed JSON */ }
  };

  socket.onclose = (ev) => {
    console.warn('[ws] closed', { code: ev.code, reason: ev.reason });
    const wasCurrentSocket = ws === socket;
    if (wasCurrentSocket) ws = null;
    if (wasCurrentSocket && wsTokenRefreshTimer) {
      clearTimeout(wsTokenRefreshTimer);
      wsTokenRefreshTimer = null;
    }
    if (wasCurrentSocket && wsAuthRefreshAckTimer) {
      clearTimeout(wsAuthRefreshAckTimer);
      wsAuthRefreshAckTimer = null;
    }
    if (wasCurrentSocket) wsCallbacks.onDisconnect?.();
    if (wasCurrentSocket && Object.keys(activeStreamCallbacks).length > 0 && !activeChatRequestAccepted) {
      failActiveChatRequest(
        ev.code === 1009 ? 'image_payload_too_large' : 'connection_lost_before_request_accepted',
      );
    }

    // 4001 means that the access token is no longer valid (usually expired).
    // Refresh it before reconnecting, otherwise every retry would reuse the same token.
    if (wasCurrentSocket && ev.code === 4001) {
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void refreshWebSocketAccessToken().then((refreshed) => {
          if (!refreshed) {
            console.warn('[ws] token refresh failed; waiting for the next authenticated HTTP request');
            return;
          }
          reconnectDelay = 1000;
          initWebSocket();
        });
      }, delay);
      return;
    }

    // Auto-reconnect if not intentional close and not replaced by a newer connection
    if (wasCurrentSocket && ev.code !== 1000 && ev.code !== 4002) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        initWebSocket();
      }, reconnectDelay);
    }
  };

  socket.onerror = () => {
    console.warn('[ws] error');
  };
}

export function closeWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (wsTokenRefreshTimer) clearTimeout(wsTokenRefreshTimer);
  if (wsAuthRefreshAckTimer) clearTimeout(wsAuthRefreshAckTimer);
  reconnectTimer = null;
  wsTokenRefreshTimer = null;
  wsAuthRefreshAckTimer = null;
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
  currentDisplayState?: DisplayStatePayload | null,
  callbacks?: StreamCallbacks,
  options?: { isVoice?: boolean; preferredModel?: string | null; regenerate_hint?: string; skip_user_history?: boolean; regenerate_from_history?: boolean; dice_mode?: 'normal' | 'always_one' | 'always_twenty' },
  documents?: ChatSendDocument[]
) {
  // If WS is connected — send through WS
  if (ws && ws.readyState === WebSocket.OPEN) {
    activeStreamCallbacks = callbacks ?? {};
    activeChatRequestAccepted = false;
    const msg: Record<string, unknown> = { type: 'chat_send', text };
    if (chatId) msg.chat_id = chatId;
    if (images?.length) msg.images = images;
    if (documents?.length) msg.documents = documents;
    if (displayManifest) msg.display_manifest = displayManifest;
    if (currentDisplayState) msg.current_display_state = currentDisplayState;
    if (options?.isVoice) msg.is_voice = true;
    if (options?.preferredModel) msg.preferred_model = options.preferredModel;
    if (options?.regenerate_hint) msg.regenerate_hint = options.regenerate_hint;
    if (options?.skip_user_history) msg.skip_user_history = true;
    if (options?.regenerate_from_history) msg.regenerate_from_history = true;
    if (options?.dice_mode) msg.dice_mode = options.dice_mode;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      failActiveChatRequest('connection_lost_before_request_accepted');
    }
    return;
  }

  // Fallback: SSE
  await streamChatMessageSSE(text, chatId, images, displayManifest, currentDisplayState, callbacks, options, documents);
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
  currentDisplayState?: DisplayStatePayload | null,
  callbacks?: StreamCallbacks,
  options?: { isVoice?: boolean; preferredModel?: string | null; regenerate_hint?: string; skip_user_history?: boolean; regenerate_from_history?: boolean; dice_mode?: 'normal' | 'always_one' | 'always_twenty' },
  documents?: ChatSendDocument[]
) {
  const attemptStream = async (isRetry = false): Promise<void> => {
    const tokens = loadTokens();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokens?.access_token) headers['Authorization'] = `Bearer ${tokens.access_token}`;

    const body: Record<string, unknown> = { text, is_desktop: true };
    if (chatId) body.chat_id = chatId;
    if (images && images.length > 0) body.images = images;
    if (documents && documents.length > 0) body.documents = documents;
    if (displayManifest) body.display_manifest = displayManifest;
    if (currentDisplayState) body.current_display_state = currentDisplayState;
    if (options?.isVoice) body.is_voice = true;
    if (options?.preferredModel) body.preferred_model = options.preferredModel;
    if (options?.regenerate_hint) body.regenerate_hint = options.regenerate_hint;
    if (options?.skip_user_history) body.skip_user_history = true;
    if (options?.regenerate_from_history) body.regenerate_from_history = true;
    if (options?.dice_mode) body.dice_mode = options.dice_mode;

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
            else if (eventName === 'stream_token' && callbacks?.onStreamToken) callbacks.onStreamToken(data.text);
            else if (eventName === 'reasoning_token' && callbacks?.onReasoningStream) callbacks.onReasoningStream(data.text);
            else if (eventName === 'display_state' && callbacks?.onDisplayState) callbacks.onDisplayState(data);
            else if (eventName === 'desktop_action' && callbacks?.onDesktopAction) callbacks.onDesktopAction(data);
            else if (eventName === 'map_update' && callbacks?.onMapUpdate) callbacks.onMapUpdate(data);
            else if (eventName === 'dice_roll' && callbacks?.onDiceRoll) callbacks.onDiceRoll(Number(data.roll));
            else if (eventName === 'user_message_saved' && callbacks?.onUserMessageSaved) callbacks.onUserMessageSaved(data);
            else if (eventName === 'tool_status' && callbacks?.onToolStatus) callbacks.onToolStatus(data.text);
            else if (eventName === 'done' && callbacks?.onDone) callbacks.onDone(data);
            else if (eventName === 'error' && callbacks?.onError) callbacks.onError(data.error, data.message);
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
        background: payload?.background === true,
      });
      result = await (window as any).electronAPI?.executeCommands(payload.commands, { background: payload?.background === true });
    } else if (ipc_type === 'read_directory') {
      console.log('[ipc] renderer invoke readDirectory', {
        requestId: request_id,
        targetPath: payload.target_path,
      });
      result = await (window as any).electronAPI?.readDirectory(payload.target_path);
    } else if (ipc_type === 'convert_video') {
      console.log('[ipc] renderer invoke convertVideo', {
        requestId: request_id,
        sourcePath: payload?.source_path,
        outputPath: payload?.output_path,
        outputFormat: payload?.output_format,
        quality: payload?.quality,
      });
      result = await (window as any).electronAPI?.convertVideo({ ...payload, request_id });
    } else if (ipc_type === 'get_file_info') {
      console.log('[ipc] renderer invoke getFileInfo', {
        requestId: request_id,
        filePath: payload?.file_path,
      });
      result = await (window as any).electronAPI?.getFileInfo(payload);
    } else if (ipc_type === 'capture_screen') {
      console.log('[ipc] renderer invoke captureScreen', { requestId: request_id });
      result = await (window as any).electronAPI?.captureScreen();
    } else if (ipc_type === 'capture_webcam') {
      console.log('[ipc] renderer invoke captureWebcam', { requestId: request_id, payload });
      result = await (window as any).electronAPI?.captureWebcam(payload);

    } else if (ipc_type === 'visual_click') {
      console.log('[ipc] renderer invoke visualClick', {
        requestId: request_id,
        payload,
      });
      result = await (window as any).electronAPI?.visualClick(payload);
    } else if (ipc_type === 'read_file') {
      console.log('[ipc] renderer invoke readFile', {
        requestId: request_id,
        filePath: payload?.file_path,
      });
      result = await (window as any).electronAPI?.readFile(payload);
    } else if (ipc_type === 'search_file_keywords') {
      console.log('[ipc] renderer invoke searchFileKeywords', {
        requestId: request_id,
        filePath: payload?.file_path,
        query: payload?.query,
      });
      result = await (window as any).electronAPI?.searchFileKeywords(payload);
    } else if (ipc_type === 'write_file') {
      console.log('[ipc] renderer invoke writeFile', {
        requestId: request_id,
        filePath: payload?.file_path,
        mode: payload?.mode,
        contentLength: typeof payload?.content === 'string' ? payload.content.length : 0,
      });
      result = await (window as any).electronAPI?.writeFile(payload);
    } else if (ipc_type === 'edit_file_lines') {
      console.log('[ipc] renderer invoke editFileLines', {
        requestId: request_id,
        filePath: payload?.file_path,
        startLine: payload?.start_line,
        endLine: payload?.end_line,
        newContentLength: typeof payload?.new_content === 'string' ? payload.new_content.length : 0,
      });
      result = await (window as any).electronAPI?.editFileLines(payload);
    } else if (ipc_type === 'grant_session_write_workspace') {
      console.log('[ipc] renderer grant detected workspace', {
        requestId: request_id,
        filePath: payload?.file_path,
      });
      result = await (window as any).electronAPI?.grantDetectedSessionWriteFolder(payload?.file_path);
    } else if (ipc_type === 'browser_control') {
      console.log('[ipc] renderer invoke browserControl', {
        requestId: request_id,
        action: payload?.action,
        ref: payload?.ref,
        url: payload?.url,
      });
      result = await (window as any).electronAPI?.browserControl(payload);
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
  tg_id?: number;
  tg_username?: string;
  can_unlink?: boolean;
  pending_code?: string;
  expires_in?: number;
};

export async function generateLinkCodeApi(): Promise<LinkGenerateResponse> {
  return apiFetch('/api/v1/link/generate', { method: 'POST' });
}

export async function getLinkStatus(): Promise<LinkStatusResponse> {
  return apiFetch('/api/v1/link/status');
}

export type UnlinkDataOwner = 'desktop' | 'telegram';

export type TelegramUnlinkResponse = AuthResponse & {
  ok: true;
  split: {
    data_owner: UnlinkDataOwner;
    data_account_id: number;
    desktop_account_id: number;
    telegram_account_id: number;
    detached_account_id: number;
    telegram_id: number;
    telegram_username: string | null;
  };
};

export async function unlinkTelegram(dataOwner: UnlinkDataOwner): Promise<TelegramUnlinkResponse> {
  const res = await apiFetch<TelegramUnlinkResponse>('/api/v1/link/unlink', {
    method: 'POST',
    body: JSON.stringify({ data_owner: dataOwner }),
  });
  saveTokens(res);
  return res;
}

// ---------- Prompts ----------

export type PromptInfo = {
  id: number;
  name: string;
  description: string;
  is_default: number;
};

export type CustomPromptInfo = {
  id: number;
  name: string;
  description: string;
  content: string;
};

export type PromptsResponse = {
  prompts: PromptInfo[];
  custom_prompts: CustomPromptInfo[];
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

/** Create a new custom prompt. Auto-selects it server-side. */
export async function createCustomPrompt(data: {
  name: string;
  description?: string;
  content: string;
}): Promise<{ ok: boolean; prompt_id: number }> {
  return apiFetch('/api/v1/prompts/custom', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Update an existing custom prompt (by selected_id, i.e. <= -1000). */
export async function updateCustomPromptById(
  selectedId: number,
  data: { name?: string; description?: string; content?: string }
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/prompts/custom/${selectedId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** Delete a custom prompt (by selected_id). */
export async function deleteCustomPrompt(selectedId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/prompts/custom/${selectedId}`, {
    method: 'DELETE',
  });
}

/** Legacy: update the single custom_prompt_content field. */
export async function updateCustomPrompt(content: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/prompts/custom', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

/** AI-generate a prompt using the user's preferred model. */
export async function generatePrompt(data: {
  instruction: string;
  current_content?: string;
  detail?: 'minimal' | 'medium' | 'detailed' | 'none';
  preferred_model?: string;
}): Promise<{ generated_prompt: string }> {
  return apiFetch('/api/v1/prompts/generate', {
    method: 'POST',
    body: JSON.stringify(data),
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

export type TaskType = 'message' | 'smart_home' | 'ai_instruction';
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
  supports_vision?: boolean;
  is_free?: boolean;
};

export async function getModels(): Promise<{ models: ModelCatalogEntry[]; preferred_model: string | null; auto_reasoning_levels?: ReasoningLevel[]; auto_supports_vision?: { pro: boolean; lite: boolean } }> {
  return apiFetch('/api/v1/models');
}

export async function setPreferredModel(modelId: string | null): Promise<{ ok: boolean; preferred_model: string | null }> {
  return apiFetch('/api/v1/user/preferred-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId }),
  });
}

export async function getSubagentModel(): Promise<{ subagent_model: string | null }> {
  return apiFetch('/api/v1/user/subagent-model');
}

export async function setSubagentModel(modelId: string | null): Promise<{ ok: boolean; subagent_model: string | null }> {
  return apiFetch('/api/v1/user/subagent-model', {
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

export async function getSubagentReasoningLevel(): Promise<{ reasoning_level: ReasoningLevel | null }> {
  return apiFetch('/api/v1/user/subagent-reasoning-level');
}

export async function setSubagentReasoningLevel(level: ReasoningLevel | null): Promise<{ ok: boolean; reasoning_level: ReasoningLevel | null }> {
  return apiFetch('/api/v1/user/subagent-reasoning-level', {
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
  disable_specialized_subagents: boolean;
  disable_adhoc_subagents: boolean;
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

// ---------- UI settings ----------

export async function getUiSettings(): Promise<{ settings: UiSettings }> {
  return apiFetch('/api/v1/user/ui-settings');
}

export async function setUiSettings(settings: Partial<UiSettings>): Promise<{ ok: boolean; settings: UiSettings }> {
  return apiFetch('/api/v1/user/ui-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
}

// ---------- Interface language ----------

export async function getUserLanguage(): Promise<{ language: string | null }> {
  return apiFetch('/api/v1/user/language');
}

export async function setUserLanguage(language: string): Promise<{ ok: boolean; language: string }> {
  return apiFetch('/api/v1/user/language', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
}

export async function setUserName(name: string): Promise<{ ok: boolean; name: string }> {
  return apiFetch('/api/v1/user/name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

// ---------- Context Token Limit ----------

export type ContextTokenLimit = {
  max_context_tokens: number;
  max_context_tokens_limit: number;
};

export async function getContextTokenLimit(): Promise<ContextTokenLimit> {
  return apiFetch('/api/v1/user/context-tokens-limit');
}

export async function setContextTokenLimit(maxContextTokens: number): Promise<ContextTokenLimit> {
  return apiFetch('/api/v1/user/context-tokens-limit', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_context_tokens: maxContextTokens }),
  });
}

// ---------- Attachment Token Limit ----------

export type AttachmentTokenLimit = {
  attachment_max_tokens: number;
  attachment_max_tokens_limit: number;
  max_context_tokens: number;
};

export async function getAttachmentTokenLimit(): Promise<AttachmentTokenLimit> {
  return apiFetch('/api/v1/user/attachment-tokens-limit');
}

export async function setAttachmentTokenLimit(attachmentMaxTokens: number): Promise<AttachmentTokenLimit> {
  return apiFetch('/api/v1/user/attachment-tokens-limit', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachment_max_tokens: attachmentMaxTokens }),
  });
}

// ---------- Weekly Quota / Budget ----------

export type QuotaInfo = {
  billing_mode: 'tokens' | 'budget';
  percent: number;
  tokens: { used: number; quota: number };
  cost: { used: number; quota: number };
  resets_at: number | null;
};

export async function fetchQuota(): Promise<QuotaInfo> {
  return apiFetch('/api/v1/account/quota');
}

// ---------- Chat Attachments (Documents) ----------

export type ChatAttachmentItem = {
  message_id: number;
  name: string;
  size_bytes: number;
  mime_type: string;
  url: string;
  filename: string;
  created_at: number;
};

export async function getChatAttachments(chatId: number): Promise<{ attachments: ChatAttachmentItem[] }> {
  return apiFetch(`/api/v1/chats/${chatId}/attachments`);
}

export async function deleteAttachment(chatId: number, messageId: number, filename: string): Promise<{ ok: boolean; token_count?: number }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages/${messageId}/attachments/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
  });
}

export async function deleteMessageImage(messageId: number, imageUrl: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/v1/messages/${messageId}/images?url=${encodeURIComponent(imageUrl)}`, {
    method: 'DELETE',
  });
}

// ---------- TTS ----------

export type RemoteTtsVoice = {
  id: string;
  name: string;
  description?: string;
  language?: string;
  gender?: string;
};

export type RemoteTtsProvider = {
  id: string;
  name: string;
  voices: RemoteTtsVoice[];
};

export async function fetchTtsProviders(): Promise<{ providers: RemoteTtsProvider[] }> {
  return apiFetch('/api/v1/tts/providers');
}

export async function fetchTtsVoicePreview(
  voiceId: string,
  language: string = 'ru',
  text?: string,
): Promise<{ audio_url: string }> {
  const params = new URLSearchParams({ voice_id: voiceId, language });
  if (text) params.set('text', text);
  return apiFetch(`/api/v1/tts/preview?${params.toString()}`);
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

// ---------- Mail accounts ----------

export type MailProvider = 'google' | 'yandex' | 'custom';

export type MailAccountDto = {
  id: number;
  provider: MailProvider;
  label: string | null;
  email: string;
  login: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  is_active: boolean;
};

export type MailAccountsResponse = {
  accounts: MailAccountDto[];
  active_account_id: number | null;
};

export type MailAccountSetup = {
  provider: MailProvider;
  label?: string;
  email: string;
  app_password: string;
  login?: string;
  imap_host?: string;
  imap_port?: number;
  imap_secure?: boolean;
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
};

export async function getMailAccounts(): Promise<MailAccountsResponse> {
  return apiFetch('/api/v1/mail/accounts');
}

export async function setupMailAccount(input: MailAccountSetup): Promise<MailAccountsResponse> {
  return apiFetch('/api/v1/mail/accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function activateMailAccount(accountId: number): Promise<MailAccountsResponse> {
  return apiFetch(`/api/v1/mail/accounts/${accountId}/activate`, { method: 'POST' });
}

export async function deleteMailAccount(accountId: number): Promise<MailAccountsResponse> {
  return apiFetch(`/api/v1/mail/accounts/${accountId}`, { method: 'DELETE' });
}

// ---------- Smart Home ----------

export type SmartDeviceDto = {
  id: string;
  name: string;
  room_name: string | null;
  provider: string;
  is_group: boolean;
  type: string | null;
  capabilities: string[];
};

export type SmartHomeSettingsDto = {
  provider: string;
  has_token: boolean;
  synced_at: number | null;
};

export async function getSmartHomeSettings(): Promise<{ settings: SmartHomeSettingsDto[] }> {
  return apiFetch('/api/v1/smart-home/settings');
}

export async function getSmartHomeDevices(): Promise<{ devices: SmartDeviceDto[] }> {
  return apiFetch('/api/v1/smart-home/devices');
}

// ── Yandex ──
export async function setSmartHomeToken(token: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/smart-home/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export async function deleteSmartHomeToken(): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/smart-home/token', { method: 'DELETE' });
}

// ── Zigbee (MQTT) ──
export async function setZigbeeBroker(brokerUrl: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/smart-home/zigbee/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ broker_url: brokerUrl }),
  });
}

export async function deleteZigbeeBroker(): Promise<{ ok: boolean }> {
  return apiFetch('/api/v1/smart-home/zigbee/token', { method: 'DELETE' });
}

// ── Sync (provider-aware) ──
export async function syncSmartHomeDevices(provider: string = 'yandex'): Promise<{ synced: number }> {
  return apiFetch('/api/v1/smart-home/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
}
