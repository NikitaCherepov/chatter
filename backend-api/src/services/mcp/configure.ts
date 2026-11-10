import { notifyMcpSettingsUpdated, sendIpcToDesktop, wsClients } from '../../ws-clients.js';
import { wrapUntrustedContent } from '../web-reader.js';
import { mcpApprovalFingerprint } from './approval-policy.js';
import { cancelCall } from './client.js';
import { confirmMcpAction, type McpApprovalContext } from './confirmations.js';
import { requireConnection, saveConnection, type McpConnection } from './store.js';

const currentSettings = (row: McpConnection) => ({
  mode: row.mode,
  timeout_seconds: row.timeout_seconds,
  enabled: !!row.enabled,
});

function updatePatch(value: any, local: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length)
    throw new Error('mcp_invalid_configuration');
  const allowed = local
    ? ['mode', 'timeout_seconds', 'args', 'append_args', 'env', 'manifest_values']
    : ['mode', 'timeout_seconds'];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    ('mode' in value && !['search', 'eager'].includes(value.mode)) ||
    ('timeout_seconds' in value &&
      (!Number.isInteger(value.timeout_seconds) ||
        value.timeout_seconds < 10 ||
        value.timeout_seconds > 3600)) ||
    ('args' in value && 'append_args' in value)
  )
    throw new Error('mcp_invalid_configuration');
  for (const key of ['args', 'append_args']) {
    const args = value[key];
    if (
      key in value &&
      (!Array.isArray(args) ||
        args.length > 100 ||
        args.some((arg) => typeof arg !== 'string' || /[\x00-\x1f]/.test(arg)))
    )
      throw new Error('mcp_invalid_configuration');
  }
  for (const key of ['env', 'manifest_values']) {
    if (!(key in value)) continue;
    const fields = value[key];
    if (
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      Object.entries(fields).some(
        ([name, entry]) =>
          !/^[a-zA-Z0-9_:.\-]{1,150}$/.test(name) ||
          !(typeof entry === 'string' || (key === 'env' && entry === null)),
      )
    )
      throw new Error('mcp_invalid_configuration');
  }
  return value;
}

export async function configureMcp(
  userId: number,
  input: any,
  signal?: AbortSignal,
  context?: McpApprovalContext,
) {
  if (
    !input ||
    !Number.isSafeInteger(input.connection_id) ||
    !['read', 'update'].includes(input.action) ||
    JSON.stringify(input).length > 8000
  )
    throw new Error('mcp_invalid_configuration');
  const row = requireConnection(userId, input.connection_id, false);
  const local = row.transport === 'stdio';
  const desktop = local ? wsClients.get(userId) : undefined;
  if (local && desktop?.ws.readyState !== 1) throw new Error('mcp_desktop_not_connected');
  const read = input.action === 'read';
  if (
    read
      ? 'patch' in input ||
        (input.looking_for !== undefined &&
          (typeof input.looking_for !== 'string' ||
            input.looking_for.length > 150 ||
            /[\x00-\x1f]/.test(input.looking_for)))
      : 'looking_for' in input
  )
    throw new Error('mcp_invalid_configuration');
  const filter = read ? (input.looking_for || '').trim() : '';
  const patch = read ? undefined : updatePatch(structuredClone(input.patch), local);
  const fingerprint = mcpApprovalFingerprint(row, currentSettings(row));
  return confirmMcpAction(
    userId,
    {
      connection_id: row.id,
      operation: read ? 'config_read' : 'config_update',
      target: read ? 'read' : 'update',
      arguments: read ? { looking_for: filter || null } : patch,
    },
    row.name,
    async () => {
      const current = requireConnection(userId, row.id, false);
      if (mcpApprovalFingerprint(current, currentSettings(current)) !== fingerprint)
        throw new Error('mcp_confirmation_stale');
      if (local) {
        if (wsClients.get(userId) !== desktop) throw new Error('mcp_desktop_connection_changed');
        const result = await sendIpcToDesktop(
          userId,
          'mcp_control',
          {
            action: read ? 'read_settings' : 'update_settings',
            local_id: current.local_id,
            config_revision: current.config_revision,
            ...(read ? { looking_for: filter } : { patch }),
          },
          90_000,
          signal,
        );
        requireConnection(userId, row.id, false);
        return read
          ? JSON.stringify({
              status: 'success',
              settings: wrapUntrustedContent(JSON.stringify(result)),
            })
          : JSON.stringify(result);
      }
      if (read) {
        const settings = { ...currentSettings(current), has_credentials: !!current.credentials };
        return JSON.stringify({
          status: 'success',
          settings: Object.fromEntries(
            Object.entries(settings).filter(([key]) => key.includes(filter.toLowerCase())),
          ),
        });
      }
      saveConnection(userId, patch, current.id);
      cancelCall(userId, current.id);
      notifyMcpSettingsUpdated(userId);
      return JSON.stringify({ status: 'updated', connection_id: current.id });
    },
    signal,
    context,
  );
}
