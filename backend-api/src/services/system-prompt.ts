/**
 * Сборка системного промпта пользователя.
 *
 * Вынесен в отдельный модуль, чтобы избежать циклической зависимости
 * ai.ts <-> chats.ts. Используется:
 *  - sendMessageThroughAi (с дополнительными надбавками за голос/аватар/изображения)
 *  - getChatContextTokens (для оценки токенов системного промпта в /context-tokens)
 *  - callLiteAi (для router-промпта и auto-title)
 */
import type { UserRecord } from '../types.js';
import { COLD_MEMORY_PROMPT_HINT } from './prompts.js';

export const TOOL_USAGE_RULES = `\n\n[CRITICAL DIRECTIVE: TOOL EXECUTION]
If the user asks you to perform an action on their PC (create a file, open a website, check a service) or call a tool, YOU MUST CALL THE APPROPRIATE TOOL (e.g., execute_pc_command or else).
UNDER NO CIRCUMSTANCES should you simulate the execution using text. Do NOT write "Открываю...", "Создаю...", or "Выполняю...". Do NOT roleplay the action. Just silently output the tool call JSON.`;

export const buildSystemPrompt = (prompt: string, userName: string, coreMemory: string) => {
  return `${prompt}\n\nИмя {{user}}: ${userName}\n\n[ПОСТОЯННЫЕ ЗНАНИЯ О ПОЛЬЗОВАТЕЛЕ]\n${(coreMemory || '').trim() || 'Пока пусто.'}${COLD_MEMORY_PROMPT_HINT}${TOOL_USAGE_RULES}`;
};

export const buildTimeContext = (timezoneOffset: number) => {
  const now = new Date();
  const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
  const sign = timezoneOffset >= 0 ? '+' : '';
  return `\n\n[СИСТЕМНАЯ ИНФОРМАЦИЯ]\nТекущее Unix-время (в секундах): ${Math.floor(now.getTime() / 1000)}.\nЛокальное время пользователя: ${localTime.toISOString().replace('T', ' ').slice(0, 19)} (UTC${sign}${timezoneOffset}). При планировании задач используй local_time (HH:MM) или delay_seconds.`;
};

/**
 * Собирает базовый системный промпт для пользователя.
 *
 * Базовый = без надбавок за голос/аватар/изображения (они появляются только
 * в момент конкретного запроса). Включает:
 *  - выбранный промпт пользователя
 *  - core memory + cold memory hint + tool usage rules
 *  - временной контекст (по timezone пользователя)
 *  - pinned macros hint (если есть закреплённые макросы)
 *
 * isGuestMode=true возвращает пустой промпт (как в реальном режиме).
 */
export const buildBaseSystemPromptForUser = (
  user: UserRecord,
  promptContent: string,
  coreMemory: string | null,
  pinnedMacrosHint: string,
  isGuestMode: boolean
): string => {
  if (isGuestMode) return '';
  const userName = user.name || user.tg_username || 'Пользователь';
  const timezone = user.timezone_offset ?? 3;
  return `${buildSystemPrompt(promptContent, userName, coreMemory || '')}${buildTimeContext(timezone)}${pinnedMacrosHint}`;
};
