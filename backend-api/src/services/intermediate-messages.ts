/** Existing iteration traces contain user-facing prefaces as well as final text. */
export function getIntermediateMessages(trace: unknown): string[] {
  if (!Array.isArray(trace)) return [];
  return trace.filter(step => step && typeof step.step === 'number'
    && !step.is_final && Array.isArray(step.tool_calls) && step.tool_calls.length
    && typeof step.content === 'string' && step.content.trim())
    .map(step => step.content.trim());
}
