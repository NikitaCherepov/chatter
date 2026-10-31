import React, { lazy, Suspense, useContext, useEffect, useMemo, useState } from 'react';
import type { ExtraProps } from 'react-markdown';
import { useTranslation } from 'react-i18next';
import type { InteractiveLanguage } from '../../main/interactive-types';
import { InteractivePreview } from './InteractivePreview';
import { QuestionnaireBlock } from './Questionnaire';
import { MessageDiagram } from './MessageDiagram';
import { MarkdownSearchContext } from './MarkdownSearchContext';
import { canFormatCode, currentFormattedCode, formatCode, highlightCode, normalizeCodeLanguage, type FormattedCode } from '../lib/markdown-code-format';
import { markCodeHtml } from '../lib/markdown-search';
import s from './MarkdownRenderer.module.scss';
const MessageChart = lazy(() => import('./MessageChart'));

function text(node: { value?: string; children?: unknown[] }): string {
  return node.value ?? node.children?.map(child => text(child as Parameters<typeof text>[0])).join('') ?? '';
}

// Stable identity preserves previews while the rest of the message streams.
export function MarkdownCode({ className, children, node, ...props }: React.ComponentProps<'code'> & ExtraProps) {
  const { t } = useTranslation();
  const highlightQuery = useContext(MarkdownSearchContext);
  const lang = normalizeCodeLanguage(/language-([\w-]+)/i.exec(className ?? '')?.[1] || '');
  const properties = node?.properties ?? {};
  const isBlock = properties['data-code-block'] === 'yes' || Boolean(lang);
  const previewLanguage = properties['data-preview-language'] as InteractiveLanguage | undefined;
  const source = typeof properties['data-code-source'] === 'string' ? properties['data-code-source']
    : typeof properties['data-preview-source'] === 'string' ? properties['data-preview-source'] : text(node ?? {});
  const closed = properties['data-code-closed'] === 'yes' || properties['data-preview-closed'] === 'yes';
  const automatic = previewLanguage === 'interactive';
  const [showPreview, setShowPreview] = useState(automatic);
  const [approvedSource, setApprovedSource] = useState<string | null>(null);
  const sourceKey = `${previewLanguage}\u0000${source}`;
  const opened = automatic || approvedSource === sourceKey;
  useEffect(() => { setShowPreview(automatic); }, [automatic, sourceKey]);
  const [result, setResult] = useState<FormattedCode | null>(null);
  // Validate during render, so stale text is never visible or copied, even before effects run.
  const rendered = currentFormattedCode(result, source, lang, closed);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (!closed || !source || !canFormatCode(lang)) return;
    void (async () => {
      const formatted = await formatCode(source, lang);
      if (cancelled || formatted === null) return;
      const html = await highlightCode(formatted, lang);
      if (!cancelled) setResult({ source, language: lang, text: formatted, html });
    })();
    return () => { cancelled = true; };
  }, [source, lang, closed]);
  const highlightedHtml = useMemo(() => rendered?.html
    ? markCodeHtml(rendered.html, highlightQuery, s.searchHighlight) : null,
  [rendered?.html, highlightQuery]);

  if (lang === 'chart') return <Suspense fallback={<p role="status">{t('chart.waiting')}</p>}><MessageChart source={source} closed={closed} /></Suspense>;
  if (lang === 'diagram') return <MessageDiagram source={source} closed={closed} />;
  if (lang === 'questionnaire') return <QuestionnaireBlock source={source} closed={closed}
    fallback={<div className={s.codeBlockWrapper}><pre><code className={className}>{children}</code></pre></div>} />;
  if (!isBlock) return <code className={s.inlineCode} {...props}>{children}</code>;

  const displayCode = rendered?.text ?? source;
  return <div className={s.codeBlockWrapper} data-code-language={lang || 'text'}>
    <div className={s.codeBlockHeader}>
      <span className={s.codeLang}>{lang || 'text'}</span>
      <div className={s.codeActions}>
        {previewLanguage && <button type="button" className={s.copyBtn} disabled={!closed} onClick={() => {
          setApprovedSource(sourceKey); setShowPreview(value => opened ? !value : true);
        }}>{t(showPreview ? 'interactivePreview.code' : 'interactivePreview.preview')}</button>}
        <button type="button" className={s.copyBtn} onClick={() => void navigator.clipboard.writeText(displayCode).catch(() => {})}>{t('common.copy')}</button>
      </div>
    </div>
    {automatic && !closed && showPreview && <p className={s.previewPending}>{t('interactivePreview.waiting')}</p>}
    {opened && closed && previewLanguage && <InteractivePreview source={source} language={previewLanguage} visible={showPreview} />}
    <div hidden={showPreview && !!previewLanguage}>
      <pre>{highlightedHtml !== null
        ? <code className={className} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        : <code className={className} {...props}>{rendered ? rendered.text : children}</code>}</pre>
    </div>
  </div>;
}
