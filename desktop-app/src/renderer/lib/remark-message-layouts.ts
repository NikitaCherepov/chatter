import { parseMessageLayoutTag, type MessageLayoutTag } from './message-accents';

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
};

function container(tag: MessageLayoutTag): Node {
  const a = tag.attributes;
  const spacing = (value: string | undefined, fallback: number) => `${Number(value ?? fallback) * 4}px`;
  const css = [`--layout-gap:${spacing(a.gap, 3)}`, `padding:${spacing(a.padding, 0)}`];
  if (tag.name === 'grid') css.push(`--layout-columns:${a.columns ?? '2'}`);
  if (a.radius) css.push(`border-radius:${({ none: 0, sm: 4, md: 8, lg: 12, xl: 20 })[a.radius]}px`);
  if (a.border !== undefined) css.push('border:1px solid var(--border-light)');
  if (a.background) {
    const color = a.background.startsWith('#') ? a.background
      : a.background === 'surface' ? 'var(--bg-bubble)'
      : a.background === 'muted' ? 'var(--bg-secondary)'
      : `color-mix(in srgb, var(--color-${a.background}) 18%, transparent)`;
    css.push(`background-color:${color}`);
  }
  if (a.align) css.push(`align-items:${a.align === 'start' || a.align === 'end' ? `flex-${a.align}` : a.align}`);
  if (tag.name === 'flex') {
    css.push(`flex-direction:${a.direction ?? 'row'}`, `flex-wrap:${a.wrap === 'no' ? 'nowrap' : 'wrap'}`);
    if (a.justify) css.push(`justify-content:${a.justify === 'between' ? 'space-between' : a.justify === 'center' ? 'center' : `flex-${a.justify}`}`);
  }
  return { type: 'messageLayout', children: [], data: {
    hName: 'div', hProperties: { 'data-message-layout': tag.name, style: css.join(';') },
  } };
}

/** Fold only allowlisted standalone tags. Raw HTML is never enabled. */
export function remarkMessageLayouts() {
  return (tree: Node) => {
    const visit = (parent: Node, depth = 0) => {
      if (!parent.children || depth > 32) return;
      const output: Node[] = [];
      const stack: { tag: MessageLayoutTag; node: Node }[] = [];
      let overflowDepth = 0;
      const append = (node: Node) => (stack.at(-1)?.node.children ?? output).push(node);
      for (const node of parent.children) {
        const tag = node.type === 'html' ? parseMessageLayoutTag(node.value ?? '') : null;
        if (tag?.closing) {
          if (overflowDepth) {
            overflowDepth--;
            append({ type: 'text', value: node.value });
            continue;
          }
          if (stack.at(-1)?.tag.name === tag.name) stack.pop();
          continue;
        }
        if (tag) {
          // Bound nesting, including unfinished streamed containers.
          if (stack.length >= 8) {
            if (!tag.selfClosing) overflowDepth++;
            append({ type: 'text', value: node.value });
            continue;
          }
          const child = container(tag);
          append(child);
          if (!tag.selfClosing) stack.push({ tag, node: child });
          continue;
        }
        visit(node, depth + 1);
        append(node);
      }
      parent.children = output;
    };
    visit(tree);
  };
}
