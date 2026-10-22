import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { remarkMessageAccents } from '../lib/remark-message-accents';
import { prepareMessageAccents } from '../lib/message-accents';
import { isMessageImageUrl, remarkMessageImages } from '../lib/remark-message-images';
import { remarkMessageLayouts } from '../lib/remark-message-layouts';
import { resolveImageUrl } from '../lib/api';
import s from './MarkdownRenderer.module.scss';

type MarkdownRendererProps = {
  content: string;
  /** Scoping class appended after .md for embedder re-theming. */
  className?: string;
  /** Terms highlighted in rendered prose. Code blocks stay untouched. */
  highlightQuery?: string;
  /** Open images in the host's existing viewer instead of an external browser. */
  onImageClick?: (src: string) => void;
};

const ImageClickContext = createContext<((src: string) => void) | undefined>(undefined);

// Stable component types keep pending images mounted across streaming renders.
function MarkdownImage({ src, alt, title }: React.ComponentProps<'img'>) {
  const { t } = useTranslation();
  const resolved = src && isMessageImageUrl(src) ? resolveImageUrl(src) : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [resolved]);
  if (!resolved) return <span>{alt}</span>;
  if (failed) return <span className={s.imageError} role="img" aria-label={alt || t('messageImages.loadFailed')}>
    <span aria-hidden="true">▧</span>
    <span>{t('messageImages.loadFailed')}</span>
    {alt && <span>{alt}</span>}
  </span>;
  return <img src={resolved} alt={alt || ''}
    title={title?.startsWith('layout:') ? undefined : title}
    loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onError={() => setFailed(true)} />;
}

function MarkdownLink({ href, children, node }: React.ComponentProps<'a'> & ExtraProps) {
  const onImageClick = useContext(ImageClickContext);
  const imageNode = node?.children.find(child => child.type === 'element' && child.tagName === 'img');
  const imageLink = !!imageNode;
  const imageSrc = imageNode?.type === 'element' && typeof imageNode.properties.src === 'string'
    ? imageNode.properties.src : '';
  const localImage = imageLink && href?.startsWith('/') && isMessageImageUrl(href);
  return <a className={imageLink ? s.imageLink : s.link} href={localImage ? resolveImageUrl(href!) : href}
    onClick={event => {
      if (!onImageClick || !isMessageImageUrl(imageSrc) || event.button !== 0
        || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      onImageClick(resolveImageUrl(imageSrc));
    }}
    target="_blank" rel="noopener noreferrer" title={href}>{children}</a>;
}

function MarkdownParagraph({ children }: React.ComponentProps<'p'>) {
  return <p className={s.paragraph}>{children}</p>;
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const getHighlightTerms = (query: string): string[] => [...new Set(
  query.normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean),
)].sort((left, right) => right.length - left.length);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rehypeSearchHighlights = (options: { query?: string } = {}) => (tree: HastNode) => {
  const terms = getHighlightTerms(options.query ?? '');
  if (!terms.length) return;
  const matcher = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu');

  const visit = (node: HastNode, insideCode = false) => {
    if (!node.children?.length) return;
    const skipChildren = insideCode || node.tagName === 'code' || node.tagName === 'pre';
    const nextChildren: HastNode[] = [];

    for (const child of node.children) {
      if (!skipChildren && child.type === 'text' && child.value) {
        const parts = child.value.split(matcher);
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index];
          if (!part) continue;
          nextChildren.push(index % 2 === 1
            ? { type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: part }] }
            : { type: 'text', value: part });
        }
        continue;
      }
      visit(child, skipChildren);
      nextChildren.push(child);
    }

    node.children = nextChildren;
  };

  visit(tree);
};

export function MarkdownRenderer({ content, className, highlightQuery = '', onImageClick }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const codeRefs = useRef<Map<string, HTMLElement>>(new Map());

  const handleCopy = useCallback((codeEl: HTMLElement | undefined) => {
    if (!codeEl) return;
    const text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  return (
    <ImageClickContext.Provider value={onImageClick}>
    <div className={className ? `${s.md} ${className}` : s.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMessageLayouts, remarkMessageAccents, remarkMessageImages]}
        rehypePlugins={[rehypeHighlight, [rehypeSearchHighlights, { query: highlightQuery }]]}
        components={{
          img: MarkdownImage,
          // --- Code blocks ---
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match;

            if (isInline) {
              return (
                <code className={s.inlineCode} {...props}>
                  {children}
                </code>
              );
            }

            const lang = match[1];
            const codeId = `code-${lang}-${String(children).slice(0, 20)}`;

            return (
              <div className={s.codeBlockWrapper}>
                <div className={s.codeBlockHeader}>
                  <span className={s.codeLang}>{lang}</span>
                  <button
                    className={s.copyBtn}
                    onClick={() => handleCopy(codeRefs.current.get(codeId))}
                  >
                    {t('common.copy')}
                  </button>
                </div>
                <code
                  ref={(el) => {
                    if (el) codeRefs.current.set(codeId, el);
                  }}
                  className={className}
                  {...props}
                >
                  {children}
                </code>
              </div>
            );
          },

          // --- Pre tag: render children directly (code block wrapper is handled above) ---
          pre({ children }) {
            return <>{children}</>;
          },

          // --- Links ---
          a: MarkdownLink,

          // --- Tables ---
          table({ children }) {
            return (
              <div className={s.tableWrapper}>
                <table>{children}</table>
              </div>
            );
          },

          // --- Paragraphs ---
          p: MarkdownParagraph,

          // --- Lists ---
          ul({ children }) {
            return <ul className={s.ul}>{children}</ul>;
          },
          ol({ children }) {
            return <ol className={s.ol}>{children}</ol>;
          },
          li({ children }) {
            return <li className={s.li}>{children}</li>;
          },

          // --- Blockquote ---
          blockquote({ children }) {
            return <blockquote className={s.blockquote}>{children}</blockquote>;
          },

          // --- Headings ---
          h1({ children }) {
            return <h1 className={s.h1}>{children}</h1>;
          },
          h2({ children }) {
            return <h2 className={s.h2}>{children}</h2>;
          },
          h3({ children }) {
            return <h3 className={s.h3}>{children}</h3>;
          },
          h4({ children }) {
            return <h4 className={s.h4}>{children}</h4>;
          },

          // --- Horizontal rule ---
          hr() {
            return <hr className={s.hr} />;
          },

          // --- Strong / Em ---
          strong({ children }) {
            return <strong className={s.strong}>{children}</strong>;
          },
          em({ children }) {
            return <em className={s.em}>{children}</em>;
          },
          mark({ children }) {
            return <mark className={s.searchHighlight}>{children}</mark>;
          },
        }}
      >
        {prepareMessageAccents(content)}
      </ReactMarkdown>
    </div>
    </ImageClickContext.Provider>
  );
}
