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

export const transformMessageLink: UrlTransform = (url, key, node) =>
  key === 'href' && node.tagName === 'a' && parseMessageLink(url) ? url : defaultUrlTransform(url);
