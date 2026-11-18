import React, { createContext, useContext, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { remarkMessageAccents } from '../lib/remark-message-accents';
import { prepareMessageAccents } from '../lib/message-accents';
import { isMessageImageUrl, remarkMessageImages } from '../lib/remark-message-images';
import { remarkMessageLayouts } from '../lib/remark-message-layouts';
import { remarkInteractiveCode } from '../lib/remark-interactive-code';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { MarkdownCode } from './MarkdownCode';
import { MarkdownSearchContext } from './MarkdownSearchContext';
import { rehypeSearchHighlights } from '../lib/markdown-search';
import { ImageClickContext, MarkdownImage } from './MessageImage';
import { QuestionnaireContext, type QuestionnaireContextValue } from './Questionnaire';
import { resolveImageUrl } from '../lib/api';
import { formatMessageFilePath, parseMessageLink, remarkLocalFileLinks, transformMessageLink, type MessageLink } from '../lib/message-links';
import { useDeferredMarkdown } from '../lib/useDeferredMarkdown';
import s from './MarkdownRenderer.module.scss';

const MessageLinkContext = createContext<((link: MessageLink) => void) | undefined>(undefined);

type MarkdownRendererProps = {
  questionnaire?: QuestionnaireContextValue;
  content: string;
  /** Scoping class appended after .md for embedder re-theming. */
  className?: string;
  /** Terms highlighted in prose and code, including formatted blocks. */
  highlightQuery?: string;
  /** Open images in the host's existing viewer instead of an external browser. */
  onImageClick?: (src: string) => void;
  onMessageLink?: (link: MessageLink) => void;
  deferOffscreen?: boolean;
};

function MessageLinkButton({ link, onOpen, children }: {
  link: MessageLink;
  onOpen: (link: MessageLink) => void;
  children: React.ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={s.messageLink}
      onClick={event => {
        event.stopPropagation();
        onOpen(link);
      }}
    >
      <Icon name={link.kind === 'file' ? 'file' : 'chat'} size={15} className={s.messageLinkIcon} />
      <span className={s.messageLinkLabel}>{children}</span>
    </button>
  );

  if (link.kind !== 'file') return button;

  const filePath = formatMessageFilePath(link.url, globalThis.window?.electronAPI?.platform === 'win32');
  return <Tooltip content={filePath} arrowAtPointer>{button}</Tooltip>;
}

function MarkdownLink({ href, children, node }: React.ComponentProps<'a'> & ExtraProps) {
  const onImageClick = useContext(ImageClickContext);
  const onMessageLink = useContext(MessageLinkContext);
  const messageLink = href && parseMessageLink(href);
  if (messageLink) {
    if (!onMessageLink) return <>{children}</>;
    return <MessageLinkButton link={messageLink} onOpen={onMessageLink}>{children}</MessageLinkButton>;
  }
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

export function MarkdownRenderer({ content, className, highlightQuery = '', onImageClick, questionnaire, onMessageLink, deferOffscreen = false }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useDeferredMarkdown(containerRef, deferOffscreen && content.length >= 8_000, content);
  const components = useMemo<Components>(() => ({
    img: MarkdownImage,
    // --- Code blocks ---
    code: MarkdownCode,

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
  }), []);
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

  return (
    <MarkdownSearchContext.Provider value={highlightQuery}>
    <QuestionnaireContext.Provider value={questionnaire}>
    <ImageClickContext.Provider value={onImageClick}>
    <MessageLinkContext.Provider value={onMessageLink}>
    <div ref={containerRef} className={className ? `${s.md} ${className}` : s.md}>
      {markdown}
    </div>
    </MessageLinkContext.Provider>
    </ImageClickContext.Provider>
    </QuestionnaireContext.Provider>
    </MarkdownSearchContext.Provider>
  );
}
