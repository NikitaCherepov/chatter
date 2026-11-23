import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
let snapshot: AppearanceShellState | undefined, unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!unsubscribe && api()) unsubscribe = api().subscribe((state: AppearanceShellState) => {
    snapshot = state; for (const notify of listeners) notify();
  });
  return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; } };
}
export function useChatterState() { return useSyncExternalStore(subscribe, () => snapshot); }

export function Image({ messageId, url, alt = '', className, style }: {
  messageId: number; url: string; alt?: string; className?: string; style?: React.CSSProperties;
}) {
  const state = useChatterState(), variant = state?.messages.find(message => message.id === messageId)?.variantIndex;
  const src = useMemo(() => api()?.imageSource(messageId, url) ?? '', [messageId, url, variant, state?.activeChatId]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src) return <span>{alt}</span>;
  if (failed) return <button type="button" className="chatter-image-error" onClick={() => setFailed(false)}>
    {state?.labels.imageLoadFailed || 'Image unavailable'}{alt ? ` — ${alt}` : ''}
  </button>;
  return <img src={src} alt={alt} className={className} style={style} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onError={() => setFailed(true)} onClick={event => { event.preventDefault(); event.stopPropagation(); api()?.openImage(messageId, url); }} />;
}

export function Markdown({ messageId, content, className = '', style, components }: {
  messageId: number; content: string; className?: string; style?: React.CSSProperties; components?: Components;
}) {
  const state = useChatterState();
  const defaults = useMemo<Components>(() => ({
    img: ({ src, alt }) => <Image messageId={messageId} url={src ?? ''} alt={alt}/>,
    a: ({ href, children, node }) => <a href={href} className="chatter-message-link"
      onClick={event => { event.preventDefault(); const image = node?.children.some(child => child.type === 'element' && child.tagName === 'img');
        if (href) image ? api()?.openImage(messageId, href) : api()?.openLink(messageId, href); }}>{children}</a>,
    code: ({ children, className, node }: React.ComponentProps<'code'> & ExtraProps) => {
      const props = node?.properties ?? {}, source = typeof props['data-code-source'] === 'string' ? props['data-code-source'] : '';
      if (props['data-code-block'] !== 'yes') return <code className={className}>{children}</code>;
      const language = /language-([\w-]+)/.exec(className ?? '')?.[1] ?? 'text';
      return <div className="chatter-code" data-code-language={language}><header><span>{language}</span>
        <button type="button" onClick={() => api()?.copyText(messageId, source)}>{state?.labels.copy || 'Copy'}</button></header>
        <pre><code className={className}>{children}</code></pre></div>;
    },
    ...components,
  }), [messageId, components, state?.labels.copy]);
  const palette = state?.palette;
  const tokens = { '--text-body': palette?.text ?? 'inherit', '--text-primary': palette?.text ?? 'inherit',
    '--bg-primary': 'transparent', '--bg-bubble': palette?.surface ?? 'transparent', '--bg-secondary': palette?.surface ?? 'transparent',
    '--accent': palette?.accent ?? 'currentColor', '--border-light': 'color-mix(in srgb, currentColor 20%, transparent)',
    '--appearance-message-size': '1em', '--appearance-line-height': 'inherit', ...style } as React.CSSProperties;
  return <div className={'chatter-markdown ' + className} style={tokens} data-theme={state?.dark ? 'dark' : 'light'}>
    <MessageMarkdown content={content} components={defaults}/>
  </div>;
}

export function MessageImages({ message, className = '' }: { message: Message; className?: string }) {
  const state = useChatterState();
  return <div className={'chatter-message-images ' + className}>{(message.images ?? []).map((image, index) =>
    <figure key={image.url + index}><Image messageId={message.id} url={image.url} alt={state?.labels.image || 'Image'}/>
      <button type="button" onClick={() => api()?.downloadImage(message.id, image.url)}>{state?.labels.download || 'Download'}</button>
    </figure>)}</div>;
}

export function Attachments({ message, className = '' }: { message: Message; className?: string }) {
  const state = useChatterState();
  return <div className={'chatter-attachments ' + className}>{(message.attachments ?? []).map((file, index) =>
    <div className="chatter-attachment" key={file.url + index}><button type="button" onClick={() => api()?.openAttachment(message.id, index)}>
      <span>{file.name}</span><small>{file.mimeType} · {file.sizeBytes.toLocaleString()} B</small></button>
      <button type="button" onClick={() => api()?.downloadAttachment(message.id, index)}>{state?.labels.download || 'Download'}</button>
    </div>)}</div>;
}
