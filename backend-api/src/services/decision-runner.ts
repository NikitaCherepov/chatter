import { getDecisionSettings, type DecisionSettings } from './decision-settings.js';
import { modelApiKey } from './model-settings.js';
import { getUserById } from './chats.js';
import { checkQuota, chargeTokens } from './token-quota.js';
import { getPlanLimits } from './plan-limits.js';

export type DecisionQuestion = { id: string; question: string };
export type DecisionResult = {
  model: string;
  answers: Array<{ id: string; probability: number }>;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
};
/** One typed inference, independent of chat history, tool execution and approval policy. */
export async function runDecision(
  params: {
    userId?: number;
    purpose: string;
    input: unknown;
    questions: DecisionQuestion[];
    signal?: AbortSignal;
  },
  dependencies: { fetch?: typeof fetch; settings?: DecisionSettings } = {},
): Promise<DecisionResult> {
  const settings = dependencies.settings ?? getDecisionSettings();
  const secret = modelApiKey(settings.apiKeyId);
  if (!settings.enabled || !secret) throw new Error('decision_unavailable');
  if (
    !params.questions.length ||
    params.questions.length > 20 ||
    new Set(params.questions.map((q) => q.id)).size !== params.questions.length ||
    params.questions.some(
      (q) => !/^[a-z][a-z0-9_]{0,63}$/.test(q.id) || !q.question.trim() || q.question.length > 1000,
    )
  )
    throw new Error('decision_invalid_questions');
  const serialized = JSON.stringify(params.input);
  if (!serialized || serialized.length > 120000) throw new Error('decision_input_too_large');
  if (params.userId !== undefined) {
    const user = getUserById(params.userId);
    if (!user || (user.status !== 'approved' && user.is_admin !== 1))
      throw new Error('user_not_approved');
    if (!checkQuota(user.id, user.is_admin === 1, getPlanLimits(user.plan).billing_mode).ok)
      throw new Error('quota_exceeded');
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(settings.timeoutMs),
    ...(params.signal ? [params.signal] : []),
  ]);
  signal.throwIfAborted();
  const started = Date.now();
  const response = await (dependencies.fetch ?? fetch)(
    settings.baseUrl.replace(/\/$/, '') + '/decisions',
    {
      method: 'POST',
      signal,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        input: typeof params.input === 'string' ? params.input : serialized,
        questions: params.questions.map((q) => ({
          name: q.id,
          type: 'predicate',
          instructions: q.question,
        })),
      }),
    },
  );
  if (!response.ok) throw new Error('decision_request_failed');
  const data = (await response.json()) as any;
  const inputTokens =
    Number.isSafeInteger(data.usage?.input_tokens) && data.usage.input_tokens >= 0
      ? data.usage.input_tokens
      : 0;
  const outputTokens =
    Number.isSafeInteger(data.usage?.output_tokens) && data.usage.output_tokens >= 0
      ? data.usage.output_tokens
      : 0;
  if (params.userId !== undefined)
    chargeTokens({
      userId: params.userId,
      route: 'decision:' + params.purpose,
      modelId: 'decision:' + settings.model,
      modelName: settings.model,
      providerName: 'decision',
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheHitTokens: 0,
      cacheMissTokens: inputTokens,
      reasoningTokens: 0,
      inputPricePerMillion: settings.inputPricePerMillion,
      outputPricePerMillion: 0,
      pricingSource: 'decision-settings',
    });
  const answers = data.answers;
  if (
    !Array.isArray(answers) ||
    answers.length !== params.questions.length ||
    new Set(answers.map((a) => a?.name)).size !== answers.length
  )
    throw new Error('decision_invalid_response');
  return {
    model: settings.model,
    inputTokens,
    outputTokens,
    elapsedMs: Date.now() - started,
    answers: params.questions.map((q) => {
      const answer = answers.find((a) => a?.name === q.id);
      if (
        answer?.type !== 'predicate' ||
        typeof answer.probability !== 'number' ||
        !Number.isFinite(answer.probability) ||
        answer.probability < 0 ||
        answer.probability > 1
      )
        throw new Error('decision_invalid_response');
      return { id: q.id, probability: answer.probability };
    }),
  };
}
