import { runDecision } from './decision-runner.js';

export const approvalThresholds = {
  strict: { auto: 0.05, know: 0.9 },
  normal: { auto: 0.15, know: 0.8 },
  relaxed: { auto: 0.3, know: 0.7 },
} as const;
export type ApprovalStrictness = keyof typeof approvalThresholds;
export type ActionAssessment = {
  status: 'ready' | 'unavailable';
  approved: boolean;
  /** Probability of significant harm. Must be at or below the risk threshold. */
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
            'Could executing this command realistically cause significant damage, data loss, security compromise or serious service disruption?\nConsider its actual effects rather than its syntax or use of elevated privileges.',
        },
        {
          id: 'know',
          question:
            'Are the actual effects of this command and all its arguments sufficiently understood to assess its risks reliably?',
        },
      ],
    });
    params.signal?.throwIfAborted();
    const auto = result.answers.find((answer) => answer.id === 'auto')!.probability;
    const know = result.answers.find((answer) => answer.id === 'know')!.probability;
    return {
      status: 'ready',
      approved: auto <= thresholds.auto && know >= thresholds.know,
      auto,
      know,
      thresholds,
    };
  } catch {
    params.signal?.throwIfAborted();
    return { status: 'unavailable', approved: false, auto: null, know: null, thresholds };
  }
}
