import type { ContextSummary } from './api';
import type { AppearanceContextSummary } from '../../main/appearance-shell-types';

/** A summary is context metadata, never an ordinary assistant reply with actions. */
export function appearanceContextSummary(
  summary: ContextSummary | null | undefined,
  title: string,
): AppearanceContextSummary | null {
  return summary
    ? {
        kind: 'summary',
        title,
        content: summary.content,
        throughTimelineIndex: summary.through_timeline_index,
        sourceMessageCount: summary.source_message_count,
        tokenCount: summary.token_count,
        contextLimit: summary.context_limit,
        modelName: summary.model_name,
        providerName: summary.provider_name,
        updatedAt: summary.updated_at,
      }
    : null;
}
