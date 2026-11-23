import React, { type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppearanceShellState, AppearanceImageRequest } from '../../main/appearance-shell-types';
import { remarkLocalFileLinks, transformMessageLink } from './message-links';
import { isMessageImageUrl } from './remark-message-images';

type Message = AppearanceShellState['messages'][number];
type References = { images: Set<string>; links: Set<string>; texts: string[] };
const referencesByMessage = new WeakMap<Message, References>();

/** Parse real Markdown references (including reference links), never code examples or raw HTML. */
export function appearanceContentReferences(message: Message) {
  const existing = referencesByMessage.get(message);
  if (existing) return existing;
  const images = new Set((message.images ?? []).map(image => image.url));
  for (const file of message.attachments ?? []) if (file.mimeType.startsWith('image/')) images.add(file.url);
  const links = new Set<string>();
  const texts = [message.content, message.reasoningContent ?? '', ...(message.workLog ?? [])
    .flatMap(step => step.type === 'message' ? [step.text] : [])];
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!React.isValidElement<{ src?: string; href?: string; children?: ReactNode }>(node)) return;
    if (node.type === 'img' && node.props.src) images.add(node.props.src);
    if (node.type === 'a' && node.props.href) links.add(node.props.href);
    visit(node.props.children);
  };
  for (const text of texts) if (text) visit(ReactMarkdown({ children: text,
    remarkPlugins: [remarkGfm, remarkLocalFileLinks], urlTransform: transformMessageLink }));
  const references = { images, links, texts };
  referencesByMessage.set(message, references);
  return references;
}

export function allowedAppearanceImage(url: string): boolean {
  if (!isMessageImageUrl(url)) return false;
  if (!url.startsWith('/')) return true;
  const path = new URL(url, 'https://chatter.invalid').pathname;
  return path.startsWith('/api/v1/images/') || path.startsWith('/api/v1/attachments/');
}

export function appearanceImageRequestAllowed(state: AppearanceShellState, request: Pick<AppearanceImageRequest, 'chatId' | 'messageId' | 'variantIndex' | 'url' | 'pendingId'>) {
  if (state.activeChatId !== request.chatId) return false;
  if (request.pendingId) return request.url === 'pending:' + request.pendingId
    && Boolean(state.composer?.items.some(item => item.id === request.pendingId && item.kind === 'image'));
  if (request.messageId < 0 && request.url.startsWith('blob:')) return Boolean(state.messages.find(message => message.id === request.messageId
    && message.role === 'user' && message.variantIndex === request.variantIndex)?.images.some(image => image.url === request.url));
  if (!allowedAppearanceImage(request.url)) return false;
  const message = state.messages.find(message => message.id === request.messageId && message.variantIndex === request.variantIndex);
  return Boolean(message && appearanceContentReferences(message).images.has(request.url));
}
