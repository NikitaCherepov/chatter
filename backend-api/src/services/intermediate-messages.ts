import { separateCommandAssessment } from './command-assessment-result.js';
import type { ActionAssessment } from './action-assessment.js';

/** Existing iteration traces contain user-facing prefaces as well as final text. */
export function getIntermediateMessages(trace: unknown): string[] {
  if (!Array.isArray(trace)) return [];
  return trace.filter(step => step && typeof step.step === 'number'
    && !step.is_final && Array.isArray(step.tool_calls) && step.tool_calls.length
    && typeof step.content === 'string' && step.content.trim())
    .map(step => step.content.trim());
}

export type WorkLogEntry =
  | { type: 'message'; text: string }
  | { type: 'tool'; call: { id?: string; name: string; arguments: any; result_preview?: string; assessment?: ActionAssessment } }
  | { type: 'activity'; text: string };

/** Preserve the actual iteration order, including repeated calls and service tools. */
export function getWorkLog(trace: unknown): WorkLogEntry[] {
  if (!Array.isArray(trace)) return [];
  const entries: WorkLogEntry[] = [];
  for (const step of trace) {
    if (!step || typeof step.step !== 'number' || !Array.isArray(step.tool_calls) || !step.tool_calls.length) continue;
    if (typeof step.content === 'string' && step.content.trim()) entries.push({type:'message',text:step.content.trim()});
    const results = Array.isArray(step.results) ? step.results : [];
    step.tool_calls.forEach((call: any, index: number) => {
      const result = call.id ? results.find((item: any) => item.id === call.id)
        : results[index]?.name === call.name ? results[index] : results.find((item: any) => item.name === call.name);
      const separated = separateCommandAssessment(call.name, typeof result?.content === 'string' ? result.content : '');
      entries.push({type:'tool',call:{id:call.id,name:call.name,arguments:call.arguments,
        result_preview:separated.content ? separated.content.slice(0,250) : undefined,
        assessment:result?.assessment ?? separated.assessment}});
    });
  }
  return entries;
}
