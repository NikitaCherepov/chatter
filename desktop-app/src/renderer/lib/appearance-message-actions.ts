import type { AppearanceMessageActionName } from '../../main/appearance-shell-types';

export function canEditChatMessage(message: { user_id?: number | null } | undefined, userId?: number): boolean {
  return Boolean(message && (message.user_id == null || message.user_id === userId));
}

export function appearanceMessageActions(
  message: { id: number; role: string; content: string; questionnaire_response?: unknown; variant_count?: number },
  options: { sending: boolean; forking: boolean; switchingVariant: boolean; canEdit: boolean; canRegenerate: boolean; canFork: boolean; canTelegram: boolean },
): AppearanceMessageActionName[] {
  // Temporary streaming rows are not persisted message targets.
  if (!Number.isSafeInteger(message.id) || message.id <= 0) return [];
  const actions: AppearanceMessageActionName[] = ['copy', 'downloadDocx'];
  if (message.content.trim()) actions.push('speak');
  if (options.canTelegram) actions.push('sendTelegram');
  if (options.canFork && !options.forking) actions.push('fork');
  if (options.canEdit) {
    if (!message.questionnaire_response) actions.push('edit');
    actions.push('delete');
  }
  if (message.role === 'assistant' && !options.sending && options.canRegenerate) actions.push('regenerate', 'regenerateHint');
  if ((message.variant_count ?? 1) > 1 && !options.sending && !options.switchingVariant) actions.push('activateVariant');
  return actions;
}
