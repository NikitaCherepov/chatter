import React, { createContext, useContext, useMemo } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { MessageMarkdown } from './MessageMarkdown';
import { isMessageImageUrl } from '../lib/remark-message-images';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { MarkdownCode } from './MarkdownCode';
import { MarkdownSearchContext } from './MarkdownSearchContext';
import { ImageClickContext, MarkdownImage } from './MessageImage';
import { QuestionnaireContext, type QuestionnaireContextValue } from './Questionnaire';
import { resolveImageUrl } from '../lib/api';
import { formatMessageFilePath, parseMessageLink, type MessageLink } from '../lib/message-links';
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

export function MarkdownRenderer({ content, className, highlightQuery = '', onImageClick, questionnaire, onMessageLink, deferOffscreen = false }: MarkdownRendererProps) {
  const components = useMemo<Components>(() => ({ img: MarkdownImage, code: MarkdownCode, a: MarkdownLink }), []);
  return <MarkdownSearchContext.Provider value={highlightQuery}>
    <QuestionnaireContext.Provider value={questionnaire}>
      <ImageClickContext.Provider value={onImageClick}>
        <MessageLinkContext.Provider value={onMessageLink}>
          <MessageMarkdown content={content} className={className} highlightQuery={highlightQuery} deferOffscreen={deferOffscreen} components={components}/>
        </MessageLinkContext.Provider>
      </ImageClickContext.Provider>
    </QuestionnaireContext.Provider>
  </MarkdownSearchContext.Provider>;
}
