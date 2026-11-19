import type { ActionAssessment } from './action-assessment.js';

/** Separate display-only diagnostics before a command result enters model context. */
export function separateCommandAssessment(
  name: string,
  content: string,
): { content: string; assessment?: ActionAssessment } {
  if (name !== 'execute_pc_command' && name !== 'execute_ssh_command') return { content };
  try {
    const parsed = JSON.parse(content);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Object.hasOwn(parsed, 'auto_confirmation')
    )
      return { content };
    const { auto_confirmation: value, ...result } = parsed;
    const probability = (number: unknown) =>
      typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1;
    const valid =
      value &&
      ['ready', 'unavailable'].includes(value.status) &&
      typeof value.approved === 'boolean' &&
      probability(value.thresholds?.auto) &&
      probability(value.thresholds?.know) &&
      (value.status === 'unavailable' || (probability(value.auto) && probability(value.know)));
    return {
      content: JSON.stringify(result),
      ...(valid ? { assessment: value as ActionAssessment } : {}),
    };
  } catch {
    return { content };
  }
}

/** Nested subagent traces are retained for the UI, with diagnostics omitted on model replay. */
export function toolContentForModel(name: string, content: string): string {
  const separated = separateCommandAssessment(name, content);
  if (name !== 'spawn_subagent' && name !== 'invoke_subagent') return separated.content;
  try {
    const result = JSON.parse(separated.content);
    if (!Array.isArray(result?.subagentTrace?.iterations)) return separated.content;
    result.subagentTrace.iterations = result.subagentTrace.iterations.map((step: any) => ({
      ...step,
      results: Array.isArray(step.results)
        ? step.results.map(({ assessment: _assessment, ...entry }: any) => ({
            ...entry,
            content:
              typeof entry.content === 'string'
                ? toolContentForModel(entry.name, entry.content)
                : entry.content,
          }))
        : step.results,
    }));
    return JSON.stringify(result);
  } catch {
    return separated.content;
  }
}
