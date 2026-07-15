import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import s from './MarkdownRenderer.module.scss';

type MarkdownRendererProps = {
  content: string;
};

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const codeRefs = useRef<Map<string, HTMLElement>>(new Map());

  const handleCopy = useCallback((codeEl: HTMLElement | undefined) => {
    if (!codeEl) return;
    const text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  return (
    <div className={s.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
