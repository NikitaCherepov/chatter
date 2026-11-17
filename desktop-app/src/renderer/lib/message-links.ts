import { defaultUrlTransform, type UrlTransform } from 'react-markdown';

export type MessageLink = { kind: 'chat'; chatId: number; messageId?: number } | { kind: 'file'; url: string };

export function parseMessageLink(url: string): MessageLink | undefined {
  const chat = /^chat:([1-9][0-9]*)(?:#([1-9][0-9]*))?$/.exec(url);
  if (chat) {
    const chatId = Number(chat[1]);
    const messageId = chat[2] === undefined ? undefined : Number(chat[2]);
    if (Number.isSafeInteger(chatId) && (messageId === undefined || Number.isSafeInteger(messageId))) {
      return { kind: 'chat', chatId, messageId };
    }
  }

  if (url.startsWith('file:///') && url[8] && url[8] !== '/' && !/[?#\\]/.test(url)) {
    return { kind: 'file', url };
  }

  return undefined;
}

type MarkdownNode = {
  type: string;
  url?: string;
  children?: MarkdownNode[];
};

/** Convert literal paths before Markdown applies URI encoding. */
export function remarkLocalFileLinks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if ((node.type === 'link' || node.type === 'definition') && node.url?.startsWith('file:')) {
        const path = node.url.slice('file:'.length);
        if (/^(?:[A-Za-z]:)?\/[^/]/.test(path) && !/[\\\x00-\x1f\x7f]/.test(path)) {
          const url = new URL('file:///');
          url.pathname = path.replace(/%/g, '%25');
          node.url = url.href;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const transformMessageLink: UrlTransform = (url, key, node) =>
  key === 'href' && node.tagName === 'a' && parseMessageLink(url) ? url : defaultUrlTransform(url);
