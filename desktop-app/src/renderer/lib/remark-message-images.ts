type Node = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: Node[];
  data?: Record<string, unknown>;
};

/** Only web images and server-relative assets; never file:, data: or // hosts. */
export function isMessageImageUrl(url: string): boolean {
  if (!url || /[\s\\\u0000-\u001f\u007f]/u.test(url)) return false;
  if (url.startsWith('/')) return !url.startsWith('//');
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname;
  } catch { return false; }
}

const blank = (node: Node) => node.type === 'text' && !node.value?.trim();
const block = (tag: string, children: Node[], properties: Record<string, unknown> = {}): Node => ({
  type: 'messageImageBlock', children, data: { hName: tag, hProperties: properties },
});
const isImage = (node: Node, layout: string) => node.type === 'image'
  && node.title === `layout:${layout}` && isMessageImageUrl(node.url ?? '');

function figure(image: Node, caption: boolean): Node {
  const picture = { ...image, title: null };
  const children: Node[] = [{ type: 'link', url: image.url, children: [picture] }];
  if (caption && image.alt?.trim()) {
    children.push(block('figcaption', [{ type: 'text', value: image.alt.trim() }]));
  }
  return block('figure', children, { 'data-message-image': true });
}

function galleryImages(node: Node): Node[] | null {
  if (node.type !== 'paragraph') return null;
  const images = (node.children ?? []).filter(child => !blank(child));
  return images.length && images.every(child => isImage(child, 'gallery')) ? images : null;
}

/** Layout uses ordinary Markdown image titles, not HTML or executable model code. */
export function remarkMessageImages() {
  return (tree: Node) => {
    const visit = (parent: Node, insideLink = false) => {
      if (!parent.children) return;
      const inLink = insideLink || parent.type === 'link' || parent.type === 'linkReference';
      const result: Node[] = [];
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        const gallery = galleryImages(node);
        if (gallery) {
          while (index + 1 < parent.children.length) {
            const next = galleryImages(parent.children[index + 1]);
            if (!next) break;
            gallery.push(...next);
            index++;
          }
          result.push(block('div', gallery.map(image => figure(image, true)), { 'data-message-images': 'gallery' }));
          continue;
        }
        const children = node.type === 'paragraph' ? [...node.children ?? []] : [];
        while (children.length && blank(children[0])) children.shift();
        if (children.length && isImage(children[0], 'side')) {
          const image = children.shift()!;
          while (children.length && blank(children[0])) children.shift();
          const body: Node[] = children.length ? [{ type: 'paragraph', children }] : [];
          // Also accept a blank line between the picture and its single prose paragraph.
          const next = parent.children[index + 1];
          if (!body.length && next?.type === 'paragraph'
            && !next.children?.some(child => child.type === 'image' || child.type === 'imageReference')) {
            body.push(next);
            index++;
          }
          const parts = [figure(image, false)];
          if (body.length) parts.push(block('div', body, { 'data-message-image-body': true }));
          result.push(block('div', parts, { 'data-message-images': 'side' }));
          continue;
        }
        if (!inLink && node.type === 'image' && isMessageImageUrl(node.url ?? '')) {
          result.push({ type: 'link', url: node.url, children: [node] });
          continue;
        }
        visit(node, inLink);
        result.push(node);
      }
      parent.children = result;
    };
    visit(tree);
  };
}
