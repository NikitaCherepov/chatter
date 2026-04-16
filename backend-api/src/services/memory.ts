import type OpenAI from 'openai';
import { db } from '../db.js';
import { getUserById } from './chats.js';

const MAX_CORE_MEMORY_LENGTH = 400;

export const runCoreMemoryMerge = async (
  aiCall: (requestPayload: Record<string, unknown>) => Promise<{ response: any; usedModel: string; usedProvider: string }>,
  userId: number,
  newFact: string,
  explicitRequest: boolean
) => {
  const user = getUserById(userId);
  if (!user) return 'Ошибка: пользователь не найден.';

  const normalizedFact = newFact.trim();
  if (!normalizedFact) return 'Ошибка: пустой факт для памяти.';

  const current = (user.core_memory || '').trim();
  const systemPrompt = `Ты — безжалостный редактор памяти ИИ-ассистента.
Твоя задача: обновить профиль пользователя, интегрировав в него новый факт.

ПРАВИЛА:
1. ЖЕСТКИЙ ЛИМИТ: ровно ${MAX_CORE_MEMORY_LENGTH} символов максимум. Если превышаешь — удаляй наименее важное.
2. СТИЛЬ: Телеграфный. Никаких полных предложений.
3. Дедупликация: если новый факт конфликтует со старым — удаляй старый.
4. Верни ТОЛЬКО новый текст памяти, без комментариев.`;

  const userPrompt = `ТЕКУЩАЯ ПАМЯТЬ:\n${current || '(пусто)'}\n\nНОВЫЙ ФАКТ:\n${normalizedFact}`;

  try {
    const completion = await aiCall({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      thinking: { type: 'disabled' }
    });

    let merged = `${completion.response?.choices?.[0]?.message?.content || ''}`.trim();
    if (!merged) merged = current || normalizedFact;
    if (merged.length > MAX_CORE_MEMORY_LENGTH) merged = merged.slice(0, MAX_CORE_MEMORY_LENGTH);

    db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(merged, userId);

    if (explicitRequest) {
      return `Память обновлена: ${merged}`;
    }
    return 'Память обновлена.';
  } catch (err: any) {
    return `Ошибка обновления памяти: ${err?.message || String(err)}`;
  }
};
