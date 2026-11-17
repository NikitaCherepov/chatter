import type { IntuitionSnapshot } from './intuition.js';

export function intuitionHint(snapshot: IntuitionSnapshot | null | undefined): string {
  if (snapshot?.status !== 'ready' || !Array.isArray(snapshot.signals) || !snapshot.signals.length)
    return '';
  return (
    '\n\n[Conversational intuition]\n' +
    JSON.stringify(
      snapshot.signals.map((s) => ({
        name: s.name,
        question: s.question,
        probability: s.probability,
      })),
    ) +
    '\nTreat these scores as auxiliary signals, not facts.\n[/Conversational intuition]'
  );
}
export function stripIntuitionHint(text: string): string {
  return text.replace(
    /\n\n\[Conversational intuition\][\s\S]*?\[\/Conversational intuition\]/g,
    '',
  );
}
