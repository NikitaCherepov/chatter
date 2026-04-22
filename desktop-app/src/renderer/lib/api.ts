const API_BASE: string = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3050';

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

// ---------- Chat ----------

export type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
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

export async function createChat(title?: string): Promise<{ chat_id: number }> {
  return apiFetch('/api/v1/chats', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export async function activateChat(chatId: number): Promise<{ ok: boolean; active_chat_id: number }> {
  return apiFetch(`/api/v1/chats/${chatId}/activate`, { method: 'POST' });
}

export async function getMessages(chatId: number, limit = 50, offset = 0): Promise<{ messages: Message[] }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages?limit=${limit}&offset=${offset}`);
}

export type ChatSendResponse = {
  reply: string;
  message_id: number;
  chat_id: number;
};

export async function sendChatMessage(text: string, chatId?: number): Promise<ChatSendResponse> {
  const body: Record<string, unknown> = { text };
  if (chatId) body.chat_id = chatId;
  return apiFetch('/api/v1/chat/send', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
