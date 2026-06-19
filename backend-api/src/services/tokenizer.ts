/**
 * Локальный токенайзер для оценки размера сообщений и контекста.
 *
 * Использует o200k_base (GPT-4o / современные модели OpenRouter / DeepSeek).
 * Чистый JS (gpt-tokenizer), без WASM-зависимостей — безопасно для Electron-сборки.
 *
 * ВАЖНО:
 *  - token_count НЕ включает reasoning_content (он односторонний, не уходит в контекст).
 *  - reasoning_tokens — отдельная колонка, считается только из reasoning_content.
 *  - Для assistant-сообщений токены считаются по развёрнутому trace (как в getHistoryForAi),
 *    а не по сырому tool_calls_json, чтобы оценка совпадала с реальным payload в API.
 */
import { encode, isWithinTokenLimit } from 'gpt-tokenizer';

/** Подсчитать токены произвольной строки. */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Fallback: грубая оценка ~4 символа на токен.
    return Math.ceil(text.length / 4);
  }
}

/**
 * Подсчитать "вес" одной роли OpenAI-сообщения в контексте.
 * Учитываем накладные расходы на роль/разделители (~4 токена на обёртку).
 */
export function countMessageTokens(role: string, content: string | null | undefined): number {
  const text = content ?? '';
  // Эмпирическая надбавка на обёртку сообщения {role, content} в OpenAI-формате.
  // Ориентировочно 4 токена на структурные элементы.
  return countTokens(text) + 4;
}

/**
 * Подсчитать токены tool-call сообщения (function call + arguments).
 * Соответствует тому, как getHistoryForAi разворачивает assistant(tool_calls).
 */
export function countToolCallTokens(
  name: string,
  argumentsObj: unknown,
  fallbackId: string
): number {
  const argsStr = typeof argumentsObj === 'string' ? argumentsObj : JSON.stringify(argumentsObj ?? {});
  // assistant(content=null, tool_calls=[{id,type,function:{name,arguments}}])
  // Плюс обёртка объекта tool_call.
  return countTokens(name) + countTokens(argsStr) + countTokens(fallbackId) + 8;
}

/**
 * Подсчитать токены tool-result сообщения.
 * Соответствует {role:'tool', tool_call_id, name, content} из getHistoryForAi.
 */
export function countToolResultTokens(
  name: string,
  toolCallId: string,
  content: string
): number {
  return countTokens(name) + countTokens(toolCallId) + countTokens(content) + 6;
}

/**
 * Безопасный лимит-чек: возвращает true если text укладывается в limit.
 * Использует быстрый путь isWithinTokenLimit из gpt-tokenizer (ранняя остановка).
 */
export function fitsInTokenLimit(text: string, limit: number): boolean {
  if (!text) return true;
  try {
    return isWithinTokenLimit(text, limit) !== false;
  } catch {
    return Math.ceil(text.length / 4) <= limit;
  }
}
