import crypto from 'node:crypto';
import { WebSocket } from 'ws';

// ── WebSocket client registry ──────────────────────────────────────────────────
// Shared between server.ts (registers connections) and ai.ts (sends IPC commands).

export type WsClient = {
  ws: WebSocket;
  userId: number;
  pendingIpc: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
};

export const wsClients = new Map<number, WsClient>();

export function sendIpcToDesktop(userId: number, ipcType: string, payload: any, timeoutMs = 30000): Promise<any> {
  const client = wsClients.get(userId);
  if (!client) throw new Error('desktop_not_connected');

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pendingIpc.delete(requestId);
      reject(new Error('ipc_timeout'));
    }, timeoutMs);

    client.pendingIpc.set(requestId, { resolve, reject, timer });
    client.ws.send(JSON.stringify({ type: 'execute_ipc', request_id: requestId, ipc_type: ipcType, payload }));
  });
}

export function isDesktopOnline(userId: number): boolean {
  return wsClients.has(userId);
}
