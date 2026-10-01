import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import s from './MarkdownRenderer.module.scss';

type MarkdownRendererProps = {
  content: string;
  /** Scoping class appended after .md for embedder re-theming. */
  className?: string;
  /** Terms highlighted in rendered prose. Code blocks stay untouched. */
  highlightQuery?: string;
};

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

export function MarkdownRenderer({ content, className, highlightQuery = '' }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const codeRefs = useRef<Map<string, HTMLElement>>(new Map());

  const handleCopy = useCallback((codeEl: HTMLElement | undefined) => {
    if (!codeEl) return;
    const text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  return (
    <div className={className ? `${s.md} ${className}` : s.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSearchHighlights, { query: highlightQuery }]]}
        components={{
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
          a({ href, children }) {
            return (
              <a
                className={s.link}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={href}
              >
                {children}
              </a>
            );
          },

          // --- Tables ---
          table({ children }) {
            return (
              <div className={s.tableWrapper}>
                <table>{children}</table>
              </div>
            );
          },

          // --- Paragraphs ---
          p({ children }) {
            return <p className={s.paragraph}>{children}</p>;
          },

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
        {content}
      </ReactMarkdown>
    </div>
  );
}
