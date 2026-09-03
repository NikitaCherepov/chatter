import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * Preview of an outgoing email body (email confirmation card).
 *
 * The model may send plain text, Markdown, or full HTML. Plain/Markdown bodies
 * go through MarkdownRenderer as before. HTML bodies (block-level tags) are
 * sanitized with DOMPurify and rendered inside a sandboxed iframe with native
 * browser styling (white background, default colors) — the same way a real
 * mail client renders it. The app's theme (dark mode, accent colors) and CSS
 * cannot leak into the preview, and the email's own <style> cannot leak out.
 *
 * The HTML detection regex must stay in sync with the backend one in
 * backend-api/src/services/mail.ts (EMAIL_HTML_BLOCK_TAG_RE).
 */

const EMAIL_HTML_BLOCK_TAG_RE = /<\/?(?:html|body|head|meta|title|style|div|p|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|hr|center|section|article|header|footer|nav|font)\b[^>]*>/i;

// Force every link to open externally instead of navigating inside the frame.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node && (node as Element).tagName === 'A') {
    const anchor = node as Element;
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
});

type EmailBodyPreviewProps = {
  body: string;
};

const IFRAME_MIN_HEIGHT = 60;
const IFRAME_MAX_HEIGHT = 600;

export function EmailBodyPreview({ body }: EmailBodyPreviewProps) {
  const trimmed = `${body || ''}`.trim();
  const isHtml = EMAIL_HTML_BLOCK_TAG_RE.test(trimmed);

  const sanitizedHtml = useMemo(() => {
    if (!isHtml) return '';
    // No scripts/handlers survive; <style> is fine — it stays isolated
    // inside the sandboxed iframe and mirrors how the real email renders.
    return DOMPurify.sanitize(trimmed);
  }, [trimmed, isHtml]);

  const srcDoc = useMemo(() => (
    '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">'
    + '<style>img{max-width:100%;height:auto}pre{white-space:pre-wrap;word-break:break-word}table{max-width:100%}</style>'
    + '</head><body style="margin:0;padding:8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#111;background:#fff;word-wrap:break-word">'
    + sanitizedHtml
    + '</body></html>'
  ), [sanitizedHtml]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(140);

  useEffect(() => {
    if (!isHtml) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let observer: MutationObserver | null = null;

    const measure = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        const next = Math.max(
          IFRAME_MIN_HEIGHT,
          Math.min(IFRAME_MAX_HEIGHT, doc.body.scrollHeight + 4),
        );
        setHeight(prev => (Math.abs(prev - next) > 4 ? next : prev));
      } catch { /* cross-origin access blocked — keep fallback height */ }
    };

    const handleLoad = () => {
      measure();
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        observer = new MutationObserver(measure);
        observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
        // Late-loading images change the content height.
        doc.body.querySelectorAll('img').forEach(img => img.addEventListener('load', measure));
      } catch { /* ignore */ }
    };

    iframe.addEventListener('load', handleLoad);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      observer?.disconnect();
    };
  }, [srcDoc, isHtml]);

  if (!isHtml) {
    return <MarkdownRenderer content={body} />;
  }

  return (
    <iframe
      ref={iframeRef}
      // Scripts are blocked (no allow-scripts); allow-same-origin lets the
      // parent measure the content height; allow-popups makes target="_blank"
      // links open in an external window.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      title="email-preview"
      style={{ width: '100%', height, border: 'none', borderRadius: '6px', background: '#fff', display: 'block' }}
    />
  );
}
