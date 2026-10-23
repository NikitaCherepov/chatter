/** Explicit user preferences, separate from persona facts, memory and character identity. */
export type UserInstructionsMode = 'both' | 'persona' | 'chat' | 'off';
export function buildPlayerInstructions(
  personaInstructions: string,
  chatInstructions: string,
  mode: UserInstructionsMode = 'both',
): string {
  if (mode === 'off') return '';
  if (mode === 'chat') personaInstructions = '';
  if (mode === 'persona') chatInstructions = '';
  if (!personaInstructions.trim() && !chatInstructions.trim()) return '';
  return (
    "\n\n[USER PREFERENCES]\nThese are the user's response preferences, not persona biography or facts about past events. Chat-specific instructions refine general instructions. Apply them to the current task and conversation. For roleplay, preserve character identity rather than silently rewriting personality.\n" +
    (personaInstructions.trim()
      ? `[GENERAL PREFERENCES]\n${personaInstructions.trim()}\n[/GENERAL PREFERENCES]\n`
      : '') +
    (chatInstructions.trim()
      ? `[CHAT PREFERENCES]\n${chatInstructions.trim()}\n[/CHAT PREFERENCES]\n`
      : '') +
    '[/USER PREFERENCES]'
  );
}
