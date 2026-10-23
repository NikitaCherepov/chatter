type Node = { type: string; lang?: string; value?: string; children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } }; data?: { hProperties?: Record<string, unknown> } };

export function isClosedPreviewFence(source: string): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(source);
  if (!opening) return false;
  const lastLine = source.slice(source.lastIndexOf('\n') + 1);
  return new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t\\r]*$`).test(lastLine);
}

/** Preserve raw source before highlighting. An incomplete fence must never execute. */
export function remarkInteractiveCode() {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: Node) => {
      if (node.type === 'code' && ['interactive', 'jsx', 'tsx', 'html', 'questionnaire'].includes(node.lang ?? '')) {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        const closed = start !== undefined && end !== undefined && isClosedPreviewFence(source.slice(start, end));
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties,
          'data-preview-source': node.value ?? '', 'data-preview-language': node.lang, 'data-preview-closed': closed ? 'yes' : 'no' } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
