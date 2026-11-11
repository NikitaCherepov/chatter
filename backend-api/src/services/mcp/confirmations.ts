import crypto from 'node:crypto';
import { requireConnection, type McpConnection } from './store.js';
import {
  approvalPolicy,
  isMcpAutoApproved,
  saveMcpApproval,
  mcpApprovalFingerprint,
} from './approval-policy.js';
import {
  registerPendingPcConfirmation,
  deletePendingPcConfirmation,
} from '../pc-command-confirmations.js';
import { sendToDesktop } from '../../ws-clients.js';
export type McpApprovalContext = {
  autoRejectHitl?: boolean;
  onDesktopAction?: (action: any) => Promise<void> | void;
  waitForApproval?: (promise: Promise<string>) => Promise<string>;
};
export type McpOperation = {
  connection_id: number;
  operation: 'tool' | 'resource';
  target: string;
  arguments: any;
  definition: unknown;
};
const grantQueues = new Map<string, Promise<unknown>>();
async function remember(userId: number, op: McpOperation, checked: () => Promise<unknown>) {
  const key = userId + ':' + op.connection_id,
    previous = grantQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await checked();
      const row = requireConnection(userId, op.connection_id),
        policy = approvalPolicy(row);
      const field = op.operation === 'tool' ? 'tools' : 'resources';
      await saveMcpApproval(userId, row.id, {
        ...policy,
        [field]: [...new Set([...policy[field], op.target])],
      });
    });
  grantQueues.set(key, next);
  try {
    await next;
  } finally {
    if (grantQueues.get(key) === next) grantQueues.delete(key);
  }
}
export async function confirmMcpOperation(
  userId: number,
  op: McpOperation,
  prepare: () => Promise<{ row: McpConnection; definition: unknown }>,
  execute: () => Promise<string>,
  signal?: AbortSignal,
  context?: McpApprovalContext,
): Promise<string> {
  signal?.throwIfAborted();
  const initial = await prepare(),
    fingerprint = mcpApprovalFingerprint(initial.row, initial.definition);
  const checked = async () => {
    signal?.throwIfAborted();
    const current = await prepare();
    if (mcpApprovalFingerprint(current.row, current.definition) !== fingerprint)
      throw new Error('mcp_confirmation_stale');
    return current;
  };
  if (isMcpAutoApproved(initial.row, op.operation, op.target)) return execute();
  return confirmMcpAction(
    userId,
    {
      connection_id: op.connection_id,
      operation: op.operation,
      target: op.target,
      arguments: op.arguments,
    },
    initial.row.name,
    async (rememberChoice) => {
      await checked();
      if (rememberChoice) await remember(userId, op, checked);
      await checked();
      return execute();
    },
    signal,
    context,
  );
}

export async function confirmMcpAction(
  userId: number,
  op: {
    connection_id?: number;
    operation: 'tool' | 'resource' | 'install' | 'install_config' | 'authorize' | 'config_read' | 'config_update';
    target: string;
    arguments: unknown;
  },
  serverName: string,
  execute: (remember: boolean, reportPhase: (phase: string) => void, values?: Record<string, string>) => Promise<string>,
  signal?: AbortSignal,
  context?: McpApprovalContext,
): Promise<string> {
  signal?.throwIfAborted();
  if (context?.autoRejectHitl)
    return JSON.stringify({
      status: 'rejected',
      error: 'mcp_confirmation_required',
      instruction:
        'This background task cannot ask for confirmation. Do not retry without an explicit user request or saved permission.',
    });
  const id = crypto.randomUUID();
  let resolve!: (value: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Handle cancellation even while a client delivery callback is still pending.
  void promise.catch(() => {});
  const emit = (action: { action: string; value: unknown }) => {
    sendToDesktop(userId, { type: 'desktop_action', ...action });
    try {
      void Promise.resolve(context?.onDesktopAction?.(action)).catch(() => {});
    } catch {}
  };
  const emitResolution = (status: string) =>
    emit({ action: 'confirmation_resolved', value: { confirmation_id: id, status } });
  const abort = () => {
    if (deletePendingPcConfirmation(id)) {
      reject(signal?.reason instanceof Error ? signal.reason : new Error('mcp_cancelled'));
      emitResolution('rejected');
    }
  };
  registerPendingPcConfirmation(id, {
    userId,
    kind: 'mcp_action',
    label: serverName + ' / ' + (op.operation === 'install' ? 'MCP install' : op.target),
    payload: {
      ipcType: 'mcp',
      ipcPayload: op,
    },
    execute: async (options) => {
      signal?.throwIfAborted();
      return execute(options.remember, (phase) =>
        emit({ action: 'mcp_install_progress', value: { confirmation_id: id, phase } }), options.mcpValues,
      );
    },
    resolve,
    reject,
    onExpired: () => emitResolution('expired'),
    onResolved: (status) => emitResolution(status),
    createdAt: Date.now(),
  });
  signal?.addEventListener('abort', abort, { once: true });
  const action = {
    action: 'mcp_confirmation',
    value: {
      confirmation_id: id,
      ...op,
      server_name: serverName,
    },
  };
  try {
    let delivered = false;
    if (context?.onDesktopAction) {
      try {
        await context.onDesktopAction(action);
        delivered = true;
      } catch {}
    }
    if (signal?.aborted) {
      abort();
      throw signal.reason;
    }
    delivered = sendToDesktop(userId, { type: 'desktop_action', ...action }) || delivered;
    if (!delivered) throw new Error('mcp_confirmation_client_unavailable');
    return await (context?.waitForApproval ? context.waitForApproval(promise) : promise);
  } catch (error: any) {
    if (signal?.aborted) throw error;
    const message = String(error?.message || '');
    if (message === 'confirmation_expired')
      return JSON.stringify({
        status: 'timeout',
        error: 'mcp_confirmation_expired',
        instruction: 'Confirmation expired. Do not retry without a new user request.',
      });
    if (message.startsWith('rejected_by_user'))
      return JSON.stringify({
        status: 'rejected',
        error: 'mcp_rejected_by_user',
        user_comment:
          message.slice('rejected_by_user'.length).replace(/^:/, '').trim() || undefined,
        instruction: 'The user rejected this MCP action. Do not retry without a new user request.',
      });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    deletePendingPcConfirmation(id);
  }
}
