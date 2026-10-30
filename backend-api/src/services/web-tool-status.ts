/** Only display the public search query / requested URL, never other tool arguments. */
export function getWebToolStatus(name: string, raw: unknown): { key: string; values: Record<string, string> } | null {
  let args: any = raw;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (['search_web', 'web_search'].includes(name) && typeof args.query === 'string' && args.query.trim()) {
    return { key: 'toolStatus.searchQuery', values: { query: args.query.trim() } };
  }
  if (['read_webpage', 'web_reader'].includes(name) && typeof args.url === 'string' && args.url.trim()) {
    return { key: 'toolStatus.readingPage', values: { url: args.url.trim() } };
  }
  return null;
}
