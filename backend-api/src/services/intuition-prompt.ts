import type { IntuitionSnapshot } from './intuition.js';

export function intuitionHint(snapshot: IntuitionSnapshot | null | undefined): string {
  if (snapshot?.status !== 'ready' || !Array.isArray(snapshot.signals) || !snapshot.signals.length)
    return '';
  return '\n\n[Current intuition — auxiliary signals]\n'
    + snapshot.signals.map(signal =>
      signal.name.replace(/[\r\n]/g, ' ') + ': ' + signal.probability.toFixed(2)
    ).join('\n');
}
export function stripIntuitionHint(text: string): string {
  return text.replace(
    /\n\n\[Conversational intuition\][\s\S]*?\[\/Conversational intuition\]/g,
    '',
  );
}
