import crypto from 'node:crypto';
import { WebSocket } from 'ws';

// ── WebSocket client registry ──────────────────────────────────────────────────
// Shared between server.ts (registers connections) and ai.ts (sends IPC commands).

export type WsClient = {
  ws: WebSocket;
  apiUserId: number;        // JWT subject — the API account that connected
  effectiveUserId: number;  // linked_tg_id || apiUserId — the user AI operates on
  pendingIpc: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
};

// Keyed by BOTH apiUserId and effectiveUserId (they can differ when TG account is linked).
// When looking up, ai.ts passes effectiveUserId — which is what sendMessageThroughAi uses.
export const wsClients = new Map<number, WsClient>();

export function sendIpcToDesktop(userId: number, ipcType: string, payload: any, timeoutMs = 30000, signal?: AbortSignal): Promise<any> {
  const client = wsClients.get(userId);
  if (!client) {
    console.log(`[DEBUG] sendIpcToDesktop: userId=${userId} NOT FOUND in wsClients (keys: [${[...wsClients.keys()].join(',')}])`);
    throw new Error('desktop_not_connected');
  }

  // Если уже отменено — не отправляем вообще
  if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError');

  console.log(`[DEBUG] sendIpcToDesktop: userId=${userId} FOUND, apiUserId=${client.apiUserId}, effectiveUserId=${client.effectiveUserId}`);

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pendingIpc.delete(requestId);
      reject(new Error('ipc_timeout'));
    }, timeoutMs);

    // Если сигнал отмены прийдёт пока ждём — чистим pending и режектим
    const onAbort = () => {
      client.pendingIpc.delete(requestId);
      clearTimeout(timer);
      reject(new DOMException('The user aborted a request.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    client.pendingIpc.set(requestId, {
      resolve: (data: any) => { signal?.removeEventListener('abort', onAbort); clearTimeout(timer); resolve(data); },
      reject: (err: Error) => { signal?.removeEventListener('abort', onAbort); clearTimeout(timer); reject(err); },
      timer,
    });
    client.ws.send(JSON.stringify({ type: 'execute_ipc', request_id: requestId, ipc_type: ipcType, payload }));
  });
}

export function isDesktopOnline(userId: number): boolean {
  const client = wsClients.get(userId);
  console.log(`[DEBUG] isDesktopOnline(${userId}): ${client ? 'FOUND (apiUserId=' + client.apiUserId + ', effectiveUserId=' + client.effectiveUserId + ')' : 'NOT FOUND'} (wsClients keys: [${[...wsClients.keys()].join(',')}])`);
  return !!client;
}

/** Send a JSON message directly to a desktop client via WS. Returns false if not connected. */
export function sendToDesktop(userId: number, data: any): boolean {
  const client = wsClients.get(userId);
  if (!client) return false;
  client.ws.send(JSON.stringify(data));
  return true;
}

/** Register a WS client under both apiUserId and effectiveUserId keys. */
export function registerWsClient(client: WsClient) {
  wsClients.set(client.apiUserId, client);
  if (client.effectiveUserId !== client.apiUserId) {
    wsClients.set(client.effectiveUserId, client);
  }
}

/** Unregister a WS client from both keys. Only removes if the stored client matches. */
export function unregisterWsClient(client: WsClient) {
  if (wsClients.get(client.apiUserId) === client) {
    wsClients.delete(client.apiUserId);
  }
  if (client.effectiveUserId !== client.apiUserId && wsClients.get(client.effectiveUserId) === client) {
    wsClients.delete(client.effectiveUserId);
  }
}
