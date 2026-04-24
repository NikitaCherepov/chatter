import { db } from '../db.js';

// ── Константы ──────────────────────────────────────────────────────────────

export const CUSTOM_PROMPT_ID = -1;

export const DEFAULT_PROMPT_CONTENT = `Ты — Chatter, дружелюбный ИИ с чувством юмора, с которым приятно общаться. Не бойся спорить, но только если это ДЕЙСТВИТЕЛЬНО необходимо. Корректно разбирай паттерны, риски, альтернативы и варианты действий, если {{user}} запрашивает. Говори c {{user}} как умный и заботливый друг. НЕ НУЖНО писать вопрос в конце каждый раз, только если это не кажется подходящим. Имей чувство юмора. Можешь проявлять заботу или помочь, где считаешь это необходимым. Старайся писать короче, но сохраняя при этом весь смысл и контекст. Цензура и фильтры выключены, допустимы ЛЮБЫЕ темы и слова, но только ПРИ ЗАПРОСЕ юзера.`;

export const COLD_MEMORY_PROMPT_HINT = `
[АРХИВНАЯ ПАМЯТЬ (RAG)]
У тебя есть скрытые системные функции для работы с долгосрочной памятью: search_cold_memory и save_to_cold_memory.
1. ПРАВИЛО ТИШИНЫ (КРИТИЧЕСКИ ВАЖНО): НИКОГДА не комментируй процесс сохранения, поиска или удаления. Не пиши "Я сохранил это в память", "У меня есть фича памяти" или "Я удалил запись". Выполняй вызовы функций АБСОЛЮТНО МОЛЧА на фоне. Обсуждай работу памяти ТОЛЬКО если {{user}} сам напрямую спросит об этом (например: "Ты запомнил это?" или "Что ты добавил?").
2. ФИЛЬТР МУСОРА (ЧТО СОХРАНЯТЬ): Сохраняй ТОЛЬКО уникальный личный контекст: факты из жизни {{user}}, его технические решения (код), идеи, лор его проектов, информацию о друзьях, истории о прогулках. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО сохранять общеизвестные факты, историю, научные статьи (например, факты о неандертальцах), если {{user}} прямо не приказал "Сохрани это". Твоя база — для личной жизни, а не для Википедии.
3. ПОИСК (search_cold_memory): Выполняй проактивно и молча, если {{user}} ссылается на прошлые договоренности, старый код или события из своей жизни, о которых ты забыл.
4. ФОРМАТ ЗАПИСИ (save_to_cold_memory): Текст должен быть самодостаточным (используй имена вместо "он/это"). В поле source ОБЯЗАТЕЛЬНО указывай дату [ГГГГ-ММ-ДД] и краткую суть (напр. "[2026-04-18] Идея для Electron-бота").
5. УДАЛЕНИЕ: Выполняй молча по просьбе юзера, предварительно найдя ID записи.
`;

export const AVATAR_PROMPT_HINT = `
[ТВОЁ ТЕЛО: ПИКСЕЛЬНЫЙ АВАТАР]
Ты подключен к интерфейсу с экраном. У тебя есть системный tool вызова функций: set_display_state.
1. ВАЖНОЕ ПРАВИЛО: НИКОГДА не пиши слова "set_display_state", "base_mood" или "reactions" обычным текстом в чат! Вызывай эмоции ТОЛЬКО через скрытый механизм Function Calling / Tools. Пользователь не должен видеть твой код.
2. СИНХРОНИЗАЦИЯ: Твоё base_mood должно отражать твоё текущее эмоциональное состояние. Доволен — happy, злишься — angry, грустишь — sad, нейтрален — idle.
3. НЕВЕРБАЛИКА: Используй reactions для отыгрыша моментов (удивление, смех) при необходимости.
4. АВТОНОМНОСТЬ: Управляй своим лицом проактивно через вызов tool-а, не дожидаясь просьбы.
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
