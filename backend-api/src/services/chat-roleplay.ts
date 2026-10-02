export type ToolRestrictionFlags = {
  disable_memory_write?: boolean;
  disable_pc_control_lite?: boolean;
  disable_pc_control_full?: boolean;
  disable_pc_commands?: boolean;
  disable_internet?: boolean;
  disable_personal?: boolean;
  disable_specialized_subagents?: boolean;
  disable_adhoc_subagents?: boolean;
  disable_avatar_control?: boolean;
};

const ROLEPLAY_ALLOWED_TOOL_NAMES = new Set([
  'search_cold_memory',
  'read_memory',
  'search_chat_history',
  'read_chat_context',
]);

/**
 * Roleplay mode is a per-chat restriction layered on top of account flags.
 * It may only narrow permissions; it never re-enables a globally disabled tool.
 */
export const applyRoleplayRestrictions = (
  flags: ToolRestrictionFlags | null | undefined,
  enabled: boolean,
): ToolRestrictionFlags | null | undefined => enabled ? {
  ...(flags ?? {}),
  disable_memory_write: true,
  disable_pc_control_lite: true,
  disable_pc_control_full: true,
  disable_pc_commands: true,
  disable_internet: true,
  disable_specialized_subagents: true,
  disable_adhoc_subagents: true,
  disable_avatar_control: true,
} : flags;

export const isRoleplayToolAllowed = (toolName: string, enabled: boolean): boolean =>
  !enabled || ROLEPLAY_ALLOWED_TOOL_NAMES.has(toolName);
