/** Hide only the exact committed prefix; edited or legacy text must stay intact. */
export function splitWorkContent(content: string, intermediate: string[] | null | undefined) {
  const messages = (intermediate ?? []).filter(text => typeof text === 'string' && text.trim());
  if (!messages.length) return { answer: content, messages: [] as string[] };
  const prefix = messages.join('\n\n');
  if (content === prefix) return { answer: '', messages };
  if (content.startsWith(prefix + '\n\n')) return { answer: content.slice(prefix.length + 2), messages };
  // Partial next-token separators can arrive as their own chunk.
  if (content.startsWith(prefix) && /^\s*$/.test(content.slice(prefix.length))) return { answer: '', messages };
  return { answer: content, messages: [] as string[] };
}
