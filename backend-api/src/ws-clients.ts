import crypto from 'node:crypto';
import { WebSocket } from 'ws';

// ── WebSocket client registry ──────────────────────────────────────────────────
// Shared between server.ts (registers connections) and ai.ts (sends IPC commands).

export type WsClient = {
  ws: WebSocket;
  accessToken: string;
  accountId: number;
  pendingIpc: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  connectionId: string;
  connectedAt: number;
  lastMessageAt: number;
  lastPingAt: number;
  lastPongAt: number;
  missedPongs: number;
  /** True while we've asked the client to refresh its access token and are waiting for auth_refresh. */
  authRefreshInFlight: boolean;
};

// Keyed by the single canonical account ID used by every client.
export const wsClients = new Map<number, WsClient>();

export const WS_HEARTBEAT_INTERVAL_MS = 25_000;
export const WS_HEARTBEAT_GRACE_MS = 75_000;

const wsStateName = (state: number): string => {
  if (state === WebSocket.CONNECTING) return 'CONNECTING';
  if (state === WebSocket.OPEN) return 'OPEN';
  if (state === WebSocket.CLOSING) return 'CLOSING';
  if (state === WebSocket.CLOSED) return 'CLOSED';
  return `UNKNOWN(${state})`;
};

export function sendIpcToDesktop(userId: number, ipcType: string, payload: any, timeoutMs = 30000, signal?: AbortSignal): Promise<any> {
  const client = wsClients.get(userId);
  if (!client) {
    console.log(`[DEBUG] sendIpcToDesktop: userId=${userId} NOT FOUND in wsClients (keys: [${[...wsClients.keys()].join(',')}])`);
    throw new Error('desktop_not_connected');
  }
  if (client.ws.readyState !== WebSocket.OPEN) {
    console.log(`[DEBUG] sendIpcToDesktop: userId=${userId} ws not open (${wsStateName(client.ws.readyState)})`);
    throw new Error('desktop_not_connected');
  }
  const now = Date.now();
  if (now - client.lastPongAt > WS_HEARTBEAT_GRACE_MS) {
    console.warn('[ipc] refusing stale desktop ws', {
      userId,
      connectionId: client.connectionId,
      lastPongAgeMs: now - client.lastPongAt,
      lastMessageAgeMs: now - client.lastMessageAt,
    });
    throw new Error('desktop_connection_stale');
  }

  // Если уже отменено — не отправляем вообще
  if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError');

  console.log(`[DEBUG] sendIpcToDesktop: userId=${userId} FOUND, accountId=${client.accountId}`);

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cancelDesktopIpc = (reason: 'abort' | 'timeout') => {
      if (client.ws.readyState !== WebSocket.OPEN) return;
      try {
        client.ws.send(JSON.stringify({
          type: 'cancel_ipc',
          request_id: requestId,
          ipc_type: ipcType,
          reason,
        }));
      } catch (err: any) {
        console.warn('[ipc] failed to send cancellation to desktop', {
          userId, requestId, ipcType, reason, error: err?.message || String(err),
        });
      }
    };

    const timer = setTimeout(() => {
      client.pendingIpc.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
      cancelDesktopIpc('timeout');
      console.warn('[ipc] timeout waiting for desktop result', {
        userId,
        requestId,
        ipcType,
        timeoutMs,
        pendingIpcCount: client.pendingIpc.size,
      });
      reject(new Error('ipc_timeout'));
    }, timeoutMs);

    // Если сигнал отмены прийдёт пока ждём — чистим pending и режектим
    const onAbort = () => {
      client.pendingIpc.delete(requestId);
      cancelDesktopIpc('abort');
      clearTimeout(timer);
      console.warn('[ipc] aborted before desktop result', { userId, requestId, ipcType });
      reject(new DOMException('The user aborted a request.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    client.pendingIpc.set(requestId, {
      resolve: (data: any) => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        console.log('[ipc] desktop result resolved', {
          userId,
          requestId,
          ipcType,
          resultType: typeof data,
          resultPreview: typeof data === 'string' ? data.slice(0, 300) : undefined,
        });
        resolve(data);
      },
      reject: (err: Error) => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        console.warn('[ipc] desktop result rejected', { userId, requestId, ipcType, error: err.message });
        reject(err);
      },
      timer,
    });
    try {
      console.log('[ipc] sending execute_ipc to desktop', {
        userId,
        requestId,
        ipcType,
        timeoutMs,
        accountId: client.accountId,
        wsState: wsStateName(client.ws.readyState),
        connectionId: client.connectionId,
        lastPongAgeMs: Date.now() - client.lastPongAt,
        pendingIpcCount: client.pendingIpc.size,
        payloadPreview: JSON.stringify(payload).slice(0, 500),
      });
      client.ws.send(JSON.stringify({ type: 'execute_ipc', request_id: requestId, ipc_type: ipcType, payload }), (err) => {
        if (!err) {
          console.log('[ipc] execute_ipc write complete', { userId, requestId, ipcType });
          return;
        }
        client.pendingIpc.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        console.error('[ipc] execute_ipc write failed', { userId, requestId, ipcType, error: err.message });
        reject(err);
      });
    } catch (err: any) {
      client.pendingIpc.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      console.error('[ipc] execute_ipc send threw', { userId, requestId, ipcType, error: err?.message || String(err) });
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function isDesktopOnline(userId: number): boolean {
  const client = wsClients.get(userId);
  const now = Date.now();
  const fresh = !!client && now - client.lastPongAt <= WS_HEARTBEAT_GRACE_MS;
  console.log(`[DEBUG] isDesktopOnline(${userId}): ${client ? 'FOUND (accountId=' + client.accountId + ', state=' + wsStateName(client.ws.readyState) + ', connectionId=' + client.connectionId + ', lastPongAgeMs=' + (now - client.lastPongAt) + ')' : 'NOT FOUND'} (wsClients keys: [${[...wsClients.keys()].join(',')}])`);
  return !!client && client.ws.readyState === WebSocket.OPEN && fresh;
}

/** Send a JSON message directly to a desktop client via WS. Returns false if not connected. */
export function sendToDesktop(userId: number, data: any): boolean {
  const client = wsClients.get(userId);
  if (!client) return false;
  if (client.ws.readyState !== WebSocket.OPEN) {
    console.log(`[DEBUG] sendToDesktop: userId=${userId} ws not open (${wsStateName(client.ws.readyState)})`);
    return false;
  }
  if (Date.now() - client.lastPongAt > WS_HEARTBEAT_GRACE_MS) {
    console.warn('[ws] sendToDesktop skipped stale connection', {
      userId,
      connectionId: client.connectionId,
      lastPongAgeMs: Date.now() - client.lastPongAt,
    });
    return false;
  }
  try {
    client.ws.send(JSON.stringify(data), (err) => {
      if (err) console.error(`[ws] sendToDesktop failed for userId=${userId}:`, err);
    });
    return true;
  } catch (err) {
    console.error(`[ws] sendToDesktop threw for userId=${userId}:`, err);
    return false;
  }
}

/** Register a WS client under its canonical account ID. */
export function registerWsClient(client: WsClient) {
  wsClients.set(client.accountId, client);
}

/** Unregister a WS client. Only removes if the stored client matches. */
export function unregisterWsClient(client: WsClient) {
  if (wsClients.get(client.accountId) === client) {
    wsClients.delete(client.accountId);
  }
}
