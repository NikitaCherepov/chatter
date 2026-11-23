import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import type { AppearanceShellState } from '../main/appearance-shell-types';
import { MessageMarkdown } from '../renderer/components/MessageMarkdown';
import markdownStyles from '../renderer/components/MarkdownRenderer.module.scss?inline';
import componentStyles from './chatter-ui.scss?inline';

const style = document.createElement('style');
style.textContent = markdownStyles + componentStyles;
document.head.append(style);
const api = () => (window as any).chatter;
type Message = AppearanceShellState['messages'][number];
export type ImageTarget = { chatId: number; messageId: number; variantIndex: number; url: string; source: string; alt: string };
export type AttachmentTarget = { chatId: number; messageId: number; variantIndex: number; index: number; url: string; name: string; mimeType: string; sizeBytes: number };
export type ChatterStateOptions = { navigation?: boolean; confirmations?: boolean };
let snapshot: AppearanceShellState | undefined, unsubscribe: (() => void) | undefined;
let subscribedOptions: ChatterStateOptions | undefined;
const listeners = new Set<{ notify: () => void; options: { current: ChatterStateOptions } }>();
function updateSubscription() {
  if (!listeners.size) {
    const previous = unsubscribe;
    unsubscribe = undefined; subscribedOptions = undefined;
    previous?.();
    return;
  }
  const options = { navigation: [...listeners].some(item => item.options.current.navigation),
    confirmations: [...listeners].some(item => item.options.current.confirmations) };
  if (unsubscribe && subscribedOptions?.navigation === options.navigation
      && subscribedOptions.confirmations === options.confirmations) return;
  const bridge = api();
  if (!bridge) return;
  const previous = unsubscribe;
  // Register the replacement first: unchanged capabilities must not briefly turn off.
  unsubscribe = bridge.subscribe((state: AppearanceShellState) => {
    snapshot = state; for (const listener of listeners) listener.notify();
  }, options);
  subscribedOptions = options;
  previous?.();
}
function subscribe(notify: () => void, options: { current: ChatterStateOptions }) {
  const listener = { notify, options };
  listeners.add(listener); updateSubscription();
  return () => { if (listeners.delete(listener)) updateSubscription(); };
}
export function useChatterState({ navigation = false, confirmations = false }: ChatterStateOptions = {}) {
  const options = useRef({ navigation, confirmations });
  useLayoutEffect(() => {
    options.current = { navigation, confirmations };
    updateSubscription();
  },
    [navigation, confirmations]);
  const subscribeWithOptions = useCallback((notify: () => void) => subscribe(notify, options), []);
  return useSyncExternalStore(subscribeWithOptions, () => snapshot);
}

function openImage(messageId: number, url: string, alt: string, onImageClick?: (image: ImageTarget) => void) {
  if (!onImageClick) { api()?.openImage(messageId, url); return; }
  const message = snapshot?.messages.find(message => message.id === messageId);
  const source = api()?.fullImageSource(messageId, url);
  if (message && source && snapshot?.activeChatId != null) onImageClick({ chatId: snapshot.activeChatId,
    messageId, variantIndex: message.variantIndex, url, source, alt });
}

export function Image({ messageId, url, alt = '', className, style, fullSize = false, onImageClick }: {
  messageId: number; url: string; alt?: string; className?: string; style?: React.CSSProperties;
  fullSize?: boolean; onImageClick?: (image: ImageTarget) => void;
}) {
  const state = useChatterState(), variant = state?.messages.find(message => message.id === messageId)?.variantIndex;
  const src = useMemo(() => (fullSize ? api()?.fullImageSource(messageId, url) : api()?.imageSource(messageId, url)) ?? '',
    [messageId, url, variant, state?.activeChatId, fullSize]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src) return <span>{alt}</span>;
  if (failed) return <button type="button" className="chatter-image-error" onClick={() => setFailed(false)}>
    {state?.labels.imageLoadFailed || 'Image unavailable'}{alt ? ` — ${alt}` : ''}
  </button>;
  return <img src={src} alt={alt} className={className} style={style} loading={fullSize ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer"
    onError={() => setFailed(true)} onClick={event => { event.preventDefault(); event.stopPropagation(); openImage(messageId, url, alt, onImageClick); }} />;
}

export function Markdown({ messageId, content, className = '', style, components, onImageClick }: {
  messageId: number; content: string; className?: string; style?: React.CSSProperties; components?: Components;
  onImageClick?: (image: ImageTarget) => void;
}) {
  const state = useChatterState();
  const defaults = useMemo<Components>(() => ({
    img: ({ src, alt }) => <Image messageId={messageId} url={src ?? ''} alt={alt} onImageClick={onImageClick}/>,
    a: ({ href, children, node }) => <a href={href} className="chatter-message-link"
      onClick={event => { event.preventDefault(); const image = node?.children.some(child => child.type === 'element' && child.tagName === 'img');
        if (href) image ? openImage(messageId, href, '', onImageClick) : api()?.openLink(messageId, href); }}>{children}</a>,
    code: ({ children, className, node }: React.ComponentProps<'code'> & ExtraProps) => {
      const props = node?.properties ?? {}, source = typeof props['data-code-source'] === 'string' ? props['data-code-source'] : '';
      if (props['data-code-block'] !== 'yes') return <code className={className}>{children}</code>;
      const language = /language-([\w-]+)/.exec(className ?? '')?.[1] ?? 'text';
      return <div className="chatter-code" data-code-language={language}><header><span>{language}</span>
        <button type="button" onClick={() => api()?.copyText(messageId, source)}>{state?.labels.copy || 'Copy'}</button></header>
        <pre><code className={className}>{children}</code></pre></div>;
    },
    ...components,
  }), [messageId, components, state?.labels.copy, onImageClick]);
  const palette = state?.palette;
  const tokens = { '--text-body': palette?.text ?? 'inherit', '--text-primary': palette?.text ?? 'inherit',
    '--bg-primary': 'transparent', '--bg-bubble': palette?.surface ?? 'transparent', '--bg-secondary': palette?.surface ?? 'transparent',
    '--accent': palette?.accent ?? 'currentColor', '--border-light': 'color-mix(in srgb, currentColor 20%, transparent)',
    '--appearance-message-size': '1em', '--appearance-line-height': 'inherit', ...style } as React.CSSProperties;
  return <div className={'chatter-markdown ' + className} style={tokens} data-theme={state?.dark ? 'dark' : 'light'}>
    <MessageMarkdown content={content} components={defaults}/>
  </div>;
}

export function MessageImages({ message, className = '', onImageClick }: { message: Message; className?: string; onImageClick?: (image: ImageTarget) => void }) {
  const state = useChatterState();
  return <div className={'chatter-message-images ' + className}>{(message.images ?? []).map((image, index) =>
    <figure key={image.url + index}><Image messageId={message.id} url={image.url} alt={state?.labels.image || 'Image'} onImageClick={onImageClick}/>
      <button type="button" onClick={() => api()?.downloadImage(message.id, image.url)}>{state?.labels.download || 'Download'}</button>
    </figure>)}</div>;
}

export function Attachments({ message, className = '', onAttachmentClick }: { message: Message; className?: string; onAttachmentClick?: (file: AttachmentTarget) => void }) {
  const state = useChatterState();
  return <div className={'chatter-attachments ' + className}>{(message.attachments ?? []).map((file, index) =>
    <div className="chatter-attachment" key={file.url + index}><button type="button" onClick={() => {
      if (onAttachmentClick && state?.activeChatId != null) onAttachmentClick({ chatId: state.activeChatId,
        messageId: message.id, variantIndex: message.variantIndex, index, ...file });
      else api()?.openAttachment(message.id, index);
    }}>
      <span>{file.name}</span><small>{file.mimeType} · {file.sizeBytes.toLocaleString()} B</small></button>
      <button type="button" onClick={() => api()?.downloadAttachment(message.id, index)}>{state?.labels.download || 'Download'}</button>
    </div>)}</div>;
}
