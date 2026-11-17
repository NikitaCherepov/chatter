import type { IntuitionSnapshot } from './intuition.js';

export function intuitionHint(snapshot: IntuitionSnapshot | null | undefined): string {
  if (snapshot?.status !== 'ready' || !Array.isArray(snapshot.signals) || !snapshot.signals.length)
    return '';
  const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  return '\n\n[Current intuition — auxiliary signals]\n'
    + snapshot.signals.map(signal =>
      `${clean(signal.name)} (${clean(signal.question).slice(0, 240)}): ${signal.probability.toFixed(2)}`
    ).join('\n');
}
export function stripIntuitionHint(text: string): string {
  return text
    .replace(
      /\n\n\[Conversational intuition\][\s\S]*?\[\/Conversational intuition\]/g,
      '',
    )
    .replace(
      /\n\n\[Current intuition — auxiliary signals\]\n(?:[^\n]*: \d+\.\d+\n?)+/g,
      '',
    );
}
