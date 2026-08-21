/**
 * System prompt assembly for a user.
 *
 * Extracted into a separate module to avoid circular dependency
 * ai.ts <-> chats.ts. Used by:
 *  - sendMessageThroughAi (with additional hints for voice/avatar/images)
 *  - getChatContextTokens (to estimate system prompt tokens in /context-tokens)
 *  - callLiteAi (for the router prompt and auto-title)
 */
import type { UserRecord } from '../types.js';
import { COLD_MEMORY_PROMPT_HINT, LANGUAGE_HINT, SECURITY_PROTOCOL_HINT, UNTRUSTED_DATA_PROTOCOL_HINT } from './prompts.js';
export const TOOL_USAGE_RULES = `\n\n[CRITICAL DIRECTIVE: TOOL EXECUTION]
If the user asks you to perform an action on their PC (create a file, open a website, check a service) or call a tool, YOU MUST CALL THE APPROPRIATE TOOL (e.g., execute_pc_command or else).
UNDER NO CIRCUMSTANCES should you simulate the execution using text. Do NOT write "Opening...", "Creating...", or "Executing...". Do NOT roleplay the action. Just silently output the tool call JSON.`;

export const buildSystemPrompt = (
  prompt: string,
  userName: string,
  coreMemory: string,
  includeToolHints = true,
) => {
  const toolHints = includeToolHints ? `${COLD_MEMORY_PROMPT_HINT}${TOOL_USAGE_RULES}` : '';
  return `${prompt}\n\nUser name {{user}}: ${userName}\n\n[USER CORE MEMORY]\n${(coreMemory || '').trim() || 'Empty for now.'}${toolHints}${SECURITY_PROTOCOL_HINT}${UNTRUSTED_DATA_PROTOCOL_HINT}${LANGUAGE_HINT}`;
};

export const buildTimeContext = (timezoneOffset: number) => {
  const now = new Date();
  const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
  const sign = timezoneOffset >= 0 ? '+' : '';
  return `\n\n[SYSTEM INFO]\nCurrent Unix time (in seconds): ${Math.floor(now.getTime() / 1000)}.\nUser's local time: ${localTime.toISOString().replace('T', ' ').slice(0, 19)} (UTC${sign}${timezoneOffset}). When scheduling tasks, use local_time (HH:MM) or delay_seconds.`;
};

/**
 * Assembles the base system prompt for a user.
 *
 * Base = without voice/avatar/image hints (those appear only at the moment
 * of a specific request). Includes:
 *  - the user's selected prompt
 *  - core memory + cold memory hint + tool usage rules
 *  - time context (based on user's timezone)
 *  - pinned macros hint (if any pinned macros exist)
 *
 * isGuestMode=true returns an empty prompt (same as in the real mode).
 */
export const buildBaseSystemPromptForUser = (
  user: UserRecord,
  promptContent: string,
  coreMemory: string | null,
  pinnedMacrosHint: string,
  isGuestMode: boolean
): string => {
  if (isGuestMode) return '';
  const userName = user.name || 'User';
  return `${buildSystemPrompt(promptContent, userName, coreMemory || '')}${pinnedMacrosHint}`;
};
