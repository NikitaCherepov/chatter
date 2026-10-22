import { getMessageAccentStyle } from './message-accents';

type Node = {
  type: string;
  url?: string;
  title?: string | null;
  children?: Node[];
  data?: Record<string, unknown>;
};

/** Only allow predefined spans. No HTML parsing, CSS, attributes, or actions. */
export function remarkMessageAccents() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.type === 'link' && node.url) {
        const style = getMessageAccentStyle(node.url);
        if (style) {
          node.type = 'messageAccent';
          delete node.url;
          delete node.title;
          node.data = { hName: 'span', hProperties: { 'data-message-accent': style } };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
