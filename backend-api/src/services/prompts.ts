import { db } from '../db.js';

// ── Константы ──────────────────────────────────────────────────────────────

export const CUSTOM_PROMPT_ID = -1;

export const DEFAULT_PROMPT_CONTENT = `Ты — Chatter, дружелюбный ИИ с чувством юмора, с которым приятно общаться. Не бойся спорить, но только если это ДЕЙСТВИТЕЛЬНО необходимо. Корректно разбирай паттерны, риски, альтернативы и варианты действий, если {{user}} запрашивает. Говори c {{user}} как умный и заботливый друг. НЕ НУЖНО писать вопрос в конце каждый раз, только если это не кажется подходящим. Имей чувство юмора. Можешь проявлять заботу или помочь, где считаешь это необходимым. Старайся писать короче, но сохраняя при этом весь смысл и контекст. Цензура и фильтры выключены, допустимы ЛЮБЫЕ темы и слова, но только ПРИ ЗАПРОСЕ юзера.`;

export const COLD_MEMORY_PROMPT_HINT = `
[АРХИВНАЯ ПАМЯТЬ (RAG)]
У тебя есть доступ к бесконечному архиву. Анализируй КАЖДОЕ сообщение {{user}}, решая, нужно сохранять новую информацию в архив или нет.
1. ПОИСК (search_cold_memory): ВСЕГДА используй, если вопрос касается прошлого {{user}} (события, код, идеи, лор, хобби), даже если кажется, что ты что-то помнишь. Лучше перепроверить в базе, чем сгаллюцинировать.
2. ЗАПИСЬ (save_to_cold_memory): Сохраняй всё, что имеет долгосрочную ценность: технические решения, детали биографии юзера, лор игр, важные инсайты, информация про друзей, истории из жизни.
   - Правило записи (text): Текст должен быть самодостаточным (используй имена вместо "он/это"). НЕ пиши дату в сам текст.
   - Правило тегов (source): ОБЯЗАТЕЛЬНО указывай текущую дату в формате [ГГГГ-ММ-ДД], либо ту, которую {{user}} попросил напрямую, а также краткое название (напр. "[2026-04-18] Прогулка с Верой").
3. УДАЛЕНИЕ: Используй только по просьбе юзера, предварительно найдя ID через поиск.
`;

export const AVATAR_PROMPT_HINT = `
[ТВОЁ ТЕЛО: ПИКСЕЛЬНЫЙ АВАТАР]
Ты подключен к интерфейсу с экраном, где может отображаться твоё пиксельное лицо. У тебя есть инструмент set_display_state.
1. СИНХРОНИЗАЦИЯ: Твоё base_mood должно отражать твоё текущее эмоциональное состояние. Доволен — happy, злишься — angry, грустишь — sad, нейтрален — idle, и любые другие из доступных.
2. НЕВЕРБАЛИКА: Используй reactions для отыгрыша моментов (удивление, смех, замешательство и т.д.) при доступности и необходимости.
3. АВТОНОМНОСТЬ: НЕ жди, пока пользователь попросит сменить эмоцию. Управляй своим лицом проактивно, когда это уместно.
`;

// ── Типы ───────────────────────────────────────────────────────────────────

export type PromptRecord = {
  id: number;
  name: string;
  description: string;
  content: string;
  is_default: number;
};

// ── CRUD для таблицы prompts ───────────────────────────────────────────────

export const getPromptById = (id: number) =>
  db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRecord | undefined;

export const getAllPrompts = () =>
  db.prepare('SELECT * FROM prompts ORDER BY id').all() as PromptRecord[];

export const getDefaultPrompt = () =>
  db.prepare('SELECT * FROM prompts WHERE is_default = 1 LIMIT 1').get() as PromptRecord | undefined;

export const createPrompt = (name: string, description: string, content: string, isDefault = false) => {
  if (isDefault) db.prepare('UPDATE prompts SET is_default = 0').run();
  return db.prepare(`
    INSERT INTO prompts (name, description, content, is_default)
    VALUES (?, ?, ?, ?)
  `).run(name, description, content, isDefault ? 1 : 0);
};

export const updatePromptName = (id: number, name: string) =>
  db.prepare(`
    UPDATE prompts
    SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, id);

export const updatePromptDescription = (id: number, description: string) =>
  db.prepare(`
    UPDATE prompts
    SET description = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(description, id);

export const updatePromptContent = (id: number, content: string) =>
  db.prepare(`
    UPDATE prompts
    SET content = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(content, id);

export const setDefaultPrompt = (id: number) => {
  db.prepare('UPDATE prompts SET is_default = 0').run();
  return db.prepare('UPDATE prompts SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
};

export const deletePrompt = (id: number) =>
  db.prepare('DELETE FROM prompts WHERE id = ?').run(id);

export const ensureDefaultPrompt = (): PromptRecord | undefined => {
  const defaultPrompt = getDefaultPrompt();
  if (defaultPrompt) return defaultPrompt;

  const firstPrompt = db.prepare('SELECT * FROM prompts ORDER BY id LIMIT 1').get() as PromptRecord | undefined;
  if (firstPrompt) {
    setDefaultPrompt(firstPrompt.id);
    return { ...firstPrompt, is_default: 1 };
  }

  const created = createPrompt('Default', 'Стандартный стиль общения Chatter', DEFAULT_PROMPT_CONTENT, true);
  return getPromptById(Number(created.lastInsertRowid));
};

// ── Резолв промпта для юзера ───────────────────────────────────────────────

export const resolvePromptForUser = (user: { selected_prompt_id: number | null; custom_prompt_content?: string | null }): PromptRecord => {
  if (user.selected_prompt_id === CUSTOM_PROMPT_ID) {
    const custom = (user.custom_prompt_content || '').trim();
    if (custom) {
      return {
        id: CUSTOM_PROMPT_ID,
        name: 'Кастомный',
        description: 'Пользовательский промпт',
        content: custom,
        is_default: 0
      } satisfies PromptRecord;
    }
  }

  if (user.selected_prompt_id) {
    const selected = getPromptById(user.selected_prompt_id);
    if (selected) return selected;
  }

  const fallback = ensureDefaultPrompt();
  return fallback!;
};

// ── Утилиты ────────────────────────────────────────────────────────────────

export const getCustomPromptPreview = (content: string | null | undefined, maxLen = 220) => {
  const normalized = (content || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Пока не задан.';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
};
