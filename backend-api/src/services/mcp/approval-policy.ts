import crypto from 'node:crypto';
import { db } from '../../db.js';
import { requireConnection, type McpConnection } from './store.js';
import { sendIpcToDesktop, notifyMcpSettingsUpdated } from '../../ws-clients.js';
import { getLocalConnections } from './local.js';
export type McpApprovalPolicy = { allow_all: boolean; tools: string[]; resources: string[] };
export const emptyMcpApproval = (): McpApprovalPolicy => ({
  allow_all: false,
  tools: [],
  resources: [],
});
export function normalizeMcpApproval(value: unknown): McpApprovalPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('mcp_invalid_approval_policy');
  const input = value as any;
  if (
    typeof input.allow_all !== 'boolean' ||
    !Array.isArray(input.tools) ||
    input.tools.length > 200 ||
    input.tools.some(
      (name: any) => typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(name),
    ) ||
    !Array.isArray(input.resources) ||
    input.resources.length > 500 ||
    input.resources.some(
      (uri: any) =>
        typeof uri !== 'string' || !uri || uri.length > 4096 || /[\u0000-\u001f]/.test(uri),
    )
  )
    throw new Error('mcp_invalid_approval_policy');
  return {
    allow_all: input.allow_all,
    tools: [...new Set<string>(input.tools)],
    resources: [...new Set<string>(input.resources)],
  };
}
export function approvalPolicy(row: McpConnection) {
  return row.approval_policy_json
    ? normalizeMcpApproval(JSON.parse(row.approval_policy_json))
    : emptyMcpApproval();
}
export function isMcpAutoApproved(
  row: McpConnection,
  operation: 'tool' | 'resource',
  target: string,
) {
  const policy = approvalPolicy(row);
  return (
    policy.allow_all || (operation === 'tool' ? policy.tools : policy.resources).includes(target)
  );
}
export function mcpApprovalFingerprint(row: McpConnection, definition: unknown) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        row.user_id,
        row.id,
        row.url,
        row.name,
        row.credentials,
        row.config_revision,
        definition,
      ]),
    )
    .digest('hex');
}
export async function saveMcpApproval(userId: number, id: number, input: unknown) {
  const policy = normalizeMcpApproval(input),
    row = requireConnection(userId, id);
  if (row.transport === 'stdio') {
    await sendIpcToDesktop(
      userId,
      'mcp_permission',
      { local_id: row.local_id, approval_policy: policy, config_revision: row.config_revision },
      30_000,
    );
    const current = requireConnection(userId, id);
    const cached = getLocalConnections(userId).find((item) => item.id === id);
    if (!cached || current.config_revision !== row.config_revision)
      throw new Error('mcp_connection_changed');
    cached.approval_policy_json = JSON.stringify(policy);
  } else {
    db.prepare('UPDATE mcp_connections SET approval_policy_json=? WHERE id=? AND user_id=?').run(
      JSON.stringify(policy),
      id,
      userId,
    );
  }
  notifyMcpSettingsUpdated(userId);
  return policy;
}
