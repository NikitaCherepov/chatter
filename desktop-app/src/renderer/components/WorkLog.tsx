import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from './MarkdownRenderer';
import s from './WorkLog.module.scss';

export function WorkLog({ messages, generating, onImageClick }: {
  messages: string[]; generating: boolean; onImageClick?: (src: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!generating) setOpen(false); }, [generating]);
  if (!messages.length) return null;
  return <div className={s.workLog}>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        <span>{t('workLog.title')}</span><span className={s.count}>· {messages.length}</span>
      </summary>
      <div className={s.entries}>{messages.map((content, index) => <div className={s.entry} key={index}>
        <MarkdownRenderer content={content} onImageClick={onImageClick} />
      </div>)}</div>
    </details>
    {generating && !open && <div className={s.latest}>
      <MarkdownRenderer content={messages[messages.length - 1]} onImageClick={onImageClick} />
    </div>}
  </div>;
}
