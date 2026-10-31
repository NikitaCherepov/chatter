export type SearchNode = {
  type?: string; tagName?: string; value?: string;
  properties?: Record<string, unknown>; children?: SearchNode[];
};
export function searchMatcher(query: string): RegExp | null {
  const terms = [...new Set(query.normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return terms.length ? new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'giu') : null;
}
export const rehypeSearchHighlights = (options: { query?: string } = {}) => (tree: SearchNode) => {
  const matcher = searchMatcher(options.query || '');
  if (!matcher) return;
  // Keep split indices: adjacent matches and punctuation must not shift the odd/even match slots.
  const highlight = (node: SearchNode) => {
    if (!node.children || ['mark', 'script', 'style'].includes(node.tagName || '')) return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text' || !child.value) { highlight(child); return [child]; }
      return child.value.split(matcher).flatMap((part, index): SearchNode[] => !part ? [] : index % 2
        ? [{ type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: part }] }]
        : [{ type: 'text', value: part }]);
    });
  };
  highlight(tree);
};

/** Highlight only decoded text, never HTML attributes or escaped entity names. */
export function markCodeHtml(html: string, query: string, className: string): string {
  const matcher = searchMatcher(query);
  if (!matcher) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent || '').split(matcher);
      if (parts.length === 1) return;
      const fragment = doc.createDocumentFragment();
      parts.forEach((part, index) => {
        if (!part) return;
        if (index % 2) { const mark = doc.createElement('mark'); mark.className = className; mark.textContent = part; fragment.append(mark); }
        else fragment.append(doc.createTextNode(part));
      });
      node.parentNode?.replaceChild(fragment, node);
      return;
    }
    Array.from(node.childNodes).forEach(visit);
  };
  visit(doc.body);
  return doc.body.innerHTML;
}
