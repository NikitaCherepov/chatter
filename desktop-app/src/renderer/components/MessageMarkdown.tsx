import React, { useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { remarkMessageAccents } from '../lib/remark-message-accents';
import { prepareMessageAccents } from '../lib/message-accents';
import { remarkMessageImages } from '../lib/remark-message-images';
import { remarkMessageLayouts } from '../lib/remark-message-layouts';
import { remarkInteractiveCode } from '../lib/remark-interactive-code';
import { remarkLocalFileLinks, transformMessageLink } from '../lib/message-links';
import { rehypeSearchHighlights } from '../lib/markdown-search';
import { useDeferredMarkdown } from '../lib/useDeferredMarkdown';
import s from './MarkdownRenderer.module.scss';
export type MessageMarkdownProps = { content: string; className?: string; highlightQuery?: string; deferOffscreen?: boolean; components?: Components };

function MarkdownParagraph({ children }: React.ComponentProps<'p'>) {
  return <p className={s.paragraph}>{children}</p>;
}

// Shared formatting only. Trusted host services are supplied through component overrides.
export function MessageMarkdown({ content, className, highlightQuery = '', deferOffscreen = false, components: overrides }: MessageMarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useDeferredMarkdown(containerRef, deferOffscreen && content.length >= 8_000, content);
  const components = useMemo<Components>(() => ({
    // --- Code blocks ---

    // --- Pre tag: render children directly (code block wrapper is handled above) ---
    pre({ children }) {
      return <>{children}</>;
    },

    // --- Links ---

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
    ...overrides,
  }), [overrides]);
  // Context providers may update buttons/forms without reparsing the Markdown.
  const markdown = useMemo(() => (
      <ReactMarkdown
        urlTransform={transformMessageLink}
        remarkPlugins={[remarkGfm, remarkMessageLayouts, remarkMessageAccents, remarkLocalFileLinks, remarkMessageImages, remarkInteractiveCode]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }], [rehypeSearchHighlights, { query: highlightQuery }]]}
        components={components}
      >
        {prepareMessageAccents(content)}
      </ReactMarkdown>
  ), [content, highlightQuery, components]);

  return <div ref={containerRef} className={className ? `${s.md} ${className}` : s.md}>{markdown}</div>;
}
