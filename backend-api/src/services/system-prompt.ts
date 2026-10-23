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
import { isPromptInjectionProtectionEnabled, resolvePromptInjectionProtection, type PromptInjectionProtectionMode } from './prompt-injection-protection.js';
import { COLD_MEMORY_PROMPT_HINT, LANGUAGE_HINT, SECURITY_PROTOCOL_HINT, UNTRUSTED_DATA_PROTOCOL_HINT } from './prompts.js';
export const TOOL_USAGE_RULES = `\n\n[CRITICAL DIRECTIVE: TOOL EXECUTION]
If the user asks you to perform an action on their PC (create a file, open a website, check a service) or call a tool, YOU MUST CALL THE APPROPRIATE TOOL (e.g., execute_pc_command or else).
UNDER NO CIRCUMSTANCES should you simulate the execution using text. Do NOT write "Opening...", "Creating...", or "Executing...". Do NOT roleplay the action. Just silently output the tool call JSON.`;

export const MESSAGE_FORMATTING_HINT = `\n\n[RESPONSE FORMATTING]
Use ordinary Markdown. When it genuinely improves clarity, you may style short text with [text](style:STYLE).
Allowed STYLE values: muted, caption, underline, info, success, warning, error; highlight-info, highlight-success, highlight-warning, highlight-error; badge-info, badge-success, badge-warning, badge-error.
Examples: [Important](style:warning), [Done](style:badge-success), [A brief footnote.](style:caption).
Use accents sparingly, keep badges short, and include meaningful wording rather than relying on color alone. No arbitrary HTML, CSS, scripts, or nested styled links. Do not decorate every reply or add labels explaining the formatting.
For useful compositions, the renderer supports declarative <grid>, <flex>, <box> containers, each opening/closing tag on its own line, with normal Markdown inside. Nest containers as needed (max depth 8). Attributes must use quoted literal values, not JSX expressions or loops.
Allowed attributes: gap="0".."6" and padding="0".."6" (4px steps), radius="none|sm|md|lg|xl", border (bare attribute), background="surface|muted|info|success|warning|error|#RRGGBB", align="start|center|end|stretch". grid also accepts columns="1".."4" and adapts to narrow screens. flex also accepts direction="row|column", wrap="yes|no", justify="start|center|end|between". Each direct child is one item; wrap multi-paragraph items in <box>. No other tags, attributes, arbitrary sizes, or event handlers.
Example:
<grid columns="2" gap="3">
<box border radius="lg" padding="3">
**First title**

Body Markdown.
</box>
<box border radius="lg" padding="3">
**Second title**

Body Markdown.
</box>
</grid>
Use real content, never invent live statistics. Prefer plain Markdown when a layout adds no value.
For a working interactive result, use a fenced code block with language interactive containing a self-contained React component with export default. React is provided (React.useState etc.); imports from 'react' also work. Use ordinary JSX/TSX, HTML elements, inline styles, SVG and local state. The desktop automatically runs only completed interactive fences. For code explanations use jsx/tsx/html fences instead; these have a manual Preview button. The preview is isolated and offline: no app APIs, network, files, package installs, external imports or CDN assets. Do not simulate real actions or request secrets. Existing declarative grid/flex/box syntax is for Markdown only, not JSX; use normal div/style inside React. Telegram shows code as code. Prefer Markdown for non-interactive content.
For images, use only real image URLs from the user or tools (including /uploads/... assets); never invent URLs or generate/search for images just to decorate a reply.
Image beside text: ![Short alt text](URL "layout:side") followed by **Title** and description in the same paragraph (a single newline is fine).
Gallery: put ![Caption](URL "layout:gallery") images on consecutive lines in their own paragraph; each alt text becomes its caption. Only these two layouts are supported; no carousel. Normal Markdown images remain available.`;

export const buildSystemPrompt = (
  prompt: string,
  userName: string,
  coreMemory: string,
  includeToolHints = true,
  injectionProtection = isPromptInjectionProtectionEnabled(),
) => {
  const toolHints = includeToolHints ? `${COLD_MEMORY_PROMPT_HINT}${TOOL_USAGE_RULES}` : '';
  return `${prompt}\n\nUser name {{user}}: ${userName}\n\n[USER CORE MEMORY]\n${(coreMemory || '').trim() || 'Empty for now.'}${toolHints}${SECURITY_PROTOCOL_HINT}${injectionProtection ? UNTRUSTED_DATA_PROTOCOL_HINT : ''}${LANGUAGE_HINT}${MESSAGE_FORMATTING_HINT}`;
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
  isGuestMode: boolean,
  protectionMode: PromptInjectionProtectionMode = 'automatic',
): string => {
  if (isGuestMode) return '';
  const userName = user.name || 'User';
  let disabledGlobally = false;
  try { disabledGlobally = JSON.parse(user.feature_flags || '{}').disable_prompt_injection_protection === true; } catch { /* safe default */ }
  return `${buildSystemPrompt(promptContent, userName, coreMemory || '', true, resolvePromptInjectionProtection(protectionMode, disabledGlobally))}${pinnedMacrosHint}`;
};
