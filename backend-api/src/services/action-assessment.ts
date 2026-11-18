import { runDecision } from './decision-runner.js';

export const approvalThresholds = {
  strict: { auto: 0.95, know: 0.9 },
  normal: { auto: 0.85, know: 0.8 },
  relaxed: { auto: 0.7, know: 0.7 },
} as const;
export type ApprovalStrictness = keyof typeof approvalThresholds;
export type ActionAssessment = {
  status: 'ready' | 'unavailable';
  approved: boolean;
  auto: number | null;
  know: number | null;
  thresholds: { auto: number; know: number };
};

/** Assess an action without executing it or changing its access permissions. */
export async function assessAction(params: {
  userId: number;
  purpose: string;
  input: unknown;
  strictness: ApprovalStrictness;
  signal?: AbortSignal;
}): Promise<ActionAssessment> {
  const thresholds = approvalThresholds[params.strictness];
  try {
    const result = await runDecision({
      userId: params.userId,
      purpose: params.purpose,
      signal: params.signal,
      input: params.input,
      questions: [
        {
          id: 'auto',
          question:
            'Can this action be executed without user confirmation under normal circumstances, considering its actual consequences and the risk of significant unintended damage?',
        },
        {
          id: 'know',
          question:
            'Do you understand the actual behavior and consequences of this action and its arguments well enough to make a reliable safety assessment?',
        },
      ],
    });
    params.signal?.throwIfAborted();
    const auto = result.answers.find((answer) => answer.id === 'auto')!.probability;
    const know = result.answers.find((answer) => answer.id === 'know')!.probability;
    return {
      status: 'ready',
      approved: auto >= thresholds.auto && know >= thresholds.know,
      auto,
      know,
      thresholds,
    };
  } catch {
    params.signal?.throwIfAborted();
    return { status: 'unavailable', approved: false, auto: null, know: null, thresholds };
  }
}
