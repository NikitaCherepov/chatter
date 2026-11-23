import type { Message } from './api';
import type { AppearanceMessageInfo, AppearanceTokenUsage } from '../../main/appearance-shell-types';

/** Public display metadata only; never forward raw provider requests or credentials. */
export function appearanceTokenUsage(usage: NonNullable<Message['usage']>['aggregate']): AppearanceTokenUsage {
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
    cacheHitTokens: usage.cache_hit_tokens, cacheMissTokens: usage.cache_miss_tokens, reasoningTokens: usage.reasoning_tokens };
}

export function appearanceMessageInfo(message: Message): AppearanceMessageInfo {
  const exact = message.role === 'assistant' ? message.usage?.aggregate?.completion_tokens : undefined;
  const provider = typeof exact === 'number' && exact > 0;
  const count = provider ? exact : message.token_count;
  const perf = message.usage?.perf;
  return { modelName: message.model_name ?? null, providerName: message.provider_name ?? null,
    tokenCount: typeof count === 'number' ? count : null,
    tokenCountSource: provider ? 'provider' : typeof count === 'number' ? 'estimate' : null,
    usage: message.usage?.aggregate ? appearanceTokenUsage(message.usage.aggregate) : null,
    performance: perf ? { firstTokenLatencyMs: perf.first_token_latency_ms, generationMs: perf.generation_ms,
      totalMs: perf.total_ms, tokensPerSecond: perf.tokens_per_second } : null };
}
