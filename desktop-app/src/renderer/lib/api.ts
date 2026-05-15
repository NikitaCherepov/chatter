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

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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

export type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImage[] | null;
  created_at: number;
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
  message_id: number;
  chat_id: number;
  generated_images?: GeneratedImage[];
  display_state?: DisplayStatePayload | null;
};

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

// ---------- SSE Streaming ----------

export type DesktopActionPayload = {
  action: 'open_widget' | 'close_widget' | 'set_widget_data' | 'open_note' | 'read_widget_state' | 'toggle_panel';
  target?: string;
  value?: { title?: string; content?: string; note_id?: number };
};

export type StreamCallbacks = {
  onIntermediate?: (text: string) => void;
  onDisplayState?: (state: DisplayStatePayload) => void;
  onDesktopAction?: (action: DesktopActionPayload) => void;
  onToolStatus?: (text: string) => void;
  onDone?: (result: ChatSendResponse) => void;
  onError?: (err: string) => void;
};

export async function streamChatMessage(
  text: string,
  chatId?: number,
  images?: ChatSendImage[],
  displayManifest?: { moods: string[]; reactions: string[] },
  callbacks?: StreamCallbacks
) {
  const attemptStream = async (isRetry = false): Promise<void> => {
    const tokens = loadTokens();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokens?.access_token) headers['Authorization'] = `Bearer ${tokens.access_token}`;

    const body: Record<string, unknown> = { text, is_desktop: true };
    if (chatId) body.chat_id = chatId;
    if (images && images.length > 0) body.images = images;
    if (displayManifest) body.display_manifest = displayManifest;

    const res = await fetch(`${API_BASE}/api/v1/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // Refresh token при 401
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
