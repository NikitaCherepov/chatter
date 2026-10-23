import React, { useEffect, useState } from 'react';
import type { ExtraProps } from 'react-markdown';
import { useTranslation } from 'react-i18next';
import type { InteractiveLanguage } from '../../main/interactive-types';
import { InteractivePreview } from './InteractivePreview';
import s from './MarkdownRenderer.module.scss';

function text(node: { value?: string; children?: unknown[] }): string {
  return node.value ?? node.children?.map(child => text(child as Parameters<typeof text>[0])).join('') ?? '';
}

// Stable component identity preserves interactive state as the rest of a reply streams.
export function MarkdownCode({ className, children, node, ...props }: React.ComponentProps<'code'> & ExtraProps) {
  const { t } = useTranslation();
  const lang = /language-([\w-]+)/.exec(className ?? '')?.[1];
  const properties = node?.properties ?? {};
  const previewLanguage = properties['data-preview-language'] as InteractiveLanguage | undefined;
  const source = typeof properties['data-preview-source'] === 'string' ? properties['data-preview-source'] : text(node ?? {});
  const closed = properties['data-preview-closed'] === 'yes';
  const automatic = previewLanguage === 'interactive';
  const [showPreview, setShowPreview] = useState(automatic);
  const [approvedSource, setApprovedSource] = useState<string | null>(null);
  const sourceKey = `${previewLanguage}\u0000${source}`;
  const opened = automatic || approvedSource === sourceKey;
  useEffect(() => { setShowPreview(automatic); }, [automatic, sourceKey]);
  if (!lang) return <code className={s.inlineCode}>{children}</code>;
  return <div className={s.codeBlockWrapper}>
    <div className={s.codeBlockHeader}>
      <span className={s.codeLang}>{lang}</span>
      <div className={s.codeActions}>
        {previewLanguage && <button type="button" className={s.copyBtn} disabled={!closed} onClick={() => {
          setApprovedSource(sourceKey); setShowPreview(value => opened ? !value : true);
        }}>{t(showPreview ? 'interactivePreview.code' : 'interactivePreview.preview')}</button>}
        <button type="button" className={s.copyBtn} onClick={() => void navigator.clipboard.writeText(source).catch(() => {})}>{t('common.copy')}</button>
      </div>
    </div>
    {automatic && !closed && showPreview && <p className={s.previewPending}>{t('interactivePreview.waiting')}</p>}
    {opened && closed && previewLanguage && <InteractivePreview source={source} language={previewLanguage} visible={showPreview} />}
    <div hidden={showPreview && !!previewLanguage}>
      <code className={className} {...props}>{children}</code>
    </div>
  </div>;
}
