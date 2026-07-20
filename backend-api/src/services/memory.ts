import { db } from '../db.js';
import { getUserById } from './chats.js';
import { chargeTokens } from './token-quota.js';

const MAX_CORE_MEMORY_LENGTH = 400;

const extractTokens = (response: any) => Number(response?.usage?.total_tokens || 0);

export const runCoreMemoryMerge = async (
  aiCall: (requestPayload: Record<string, unknown>) => Promise<{ response: any; usedModel: string; usedProvider: string }>,
  userId: number,
  newFact: string,
  explicitRequest: boolean
) => {
  const user = getUserById(userId);
  if (!user) {
    return 'Ошибка памяти: пользователь не найден.';
  }

  const fact = newFact.trim();
  if (!fact) {
    return 'Ошибка памяти: пустой факт.';
  }

  const currentMemory = (user.core_memory || '').trim();
  const mergePrompt = `Ты — безжалостный редактор памяти ИИ-ассистента.
Твоя задача: обновить профиль пользователя, интегрировав в него новый факт.

ТЕКУЩАЯ ПАМЯТЬ:
${currentMemory || '(пусто)'}

НОВЫЙ ФАКТ:
${fact}

КОНТЕКСТ:
- Явный запрос "запомни": ${explicitRequest ? 'да' : 'нет'}.
- Если факт явно незначительный и explicitRequest=нет — можешь оставить память без изменений.

ПРАВИЛА:
1. ЖЕСТКИЙ ЛИМИТ: ровно ${MAX_CORE_MEMORY_LENGTH} символов максимум. Если превышаешь — удаляй самую старую и наименее важную информацию (оставляй ядро: кто он, где живет, кем работает, близкие люди).
2. СТИЛЬ: телеграфный. Никаких полных предложений. Используй списки, сокращения, теги.
3. Дедупликация: если новый факт конфликтует со старым (например, сменил город/работу) — удаляй старый.
4. В ответе выдай ТОЛЬКО новый текст памяти, без комментариев и JSON.`;

  let mergedMemory = currentMemory;
  let action: 'updated' | 'unchanged' = 'unchanged';
  let reason = 'без комментария';

  try {
    const completion = await aiCall({
      messages: [
        { role: 'system', content: 'Ты аккуратный модуль памяти. Верни только готовый текст памяти.' },
        { role: 'user', content: mergePrompt }
      ]
    });

    const response = completion.response;
    const mergeTokens = extractTokens(response);
    if (mergeTokens > 0) {
      // Charge via unified ledger (weekly_tokens_used + user_token_usage row).
      chargeTokens({
        userId,
        route: 'memory-merge',
        modelId: completion.usedModel || null,
        modelName: completion.usedModel || null,
        providerName: completion.usedProvider || null,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        reasoningTokens: 0,
        totalTokens: mergeTokens,
      });
    }

    const raw = response?.choices?.[0]?.message?.content?.trim() || '';
    mergedMemory = raw || currentMemory;
    if (mergedMemory.length > MAX_CORE_MEMORY_LENGTH) {
      mergedMemory = mergedMemory.slice(0, MAX_CORE_MEMORY_LENGTH).trim();
    }
    action = mergedMemory === currentMemory ? 'unchanged' : 'updated';
    reason = 'merge-модель';
  } catch {
    const fallbackCandidate = currentMemory
      ? `${currentMemory}\n- ${fact}`
      : `- ${fact}`;
    mergedMemory = fallbackCandidate.slice(0, MAX_CORE_MEMORY_LENGTH).trim();
    action = mergedMemory === currentMemory ? 'unchanged' : 'updated';
    reason = 'fallback-слияние';
  }

  if (mergedMemory !== currentMemory) {
    db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(mergedMemory, userId);
  }

  return `Память: ${action}.
Причина: ${reason}.
Текущая длина памяти: ${mergedMemory.length}/${MAX_CORE_MEMORY_LENGTH}.
Текущая память:
${mergedMemory || '(пусто)'}`;
};
