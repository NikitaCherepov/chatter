import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall, WorkLogStep } from '../lib/api';
import { describeToolCall } from '../lib/tool-activity';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolActivityCall } from './ToolActivity';
import s from './WorkLog.module.scss';

export function WorkLog({ messages, entries, calls, current, draft, generating, onImageClick }: {
  messages: string[]; entries?: WorkLogStep[]; calls?: ToolCall[] | null;
  current?: string | null; draft?: string; generating: boolean; onImageClick?: (src: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!generating) setOpen(false); }, [generating]);
  // Old flat records have no interleaving metadata; retain every available item.
  const steps: WorkLogStep[] = entries?.length ? entries
    : [...messages.map(text => ({ type: 'message' as const, text })), ...(calls ?? []).map(call => ({ type: 'tool' as const, call }))];
  const actionCount = steps.filter(step => step.type !== 'message').length;
  const errorCount = steps.filter(step => step.type === 'tool' && describeToolCall(step.call).status === 'error').length;
  if (!steps.length && !current && !draft) return null;
  return <div className={s.workLog} data-work-log>
    <details open={generating || open} onToggle={event => { if (!generating) setOpen(event.currentTarget.open); }}>
      <summary>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        <span>{t('workLog.title')}</span>
        {actionCount > 0 && <span className={s.count}>· {t('workLog.actions', { count: actionCount })}</span>}
        {errorCount > 0 && <span className={s.error}>· {t('workLog.errors', { count: errorCount })}</span>}
      </summary>
      <div className={s.entries}>{steps.map((step, index) => <div className={s.entry} key={index}>
        {step.type === 'tool' ? <ToolActivityCall call={step.call} />
          : step.type === 'message' ? <MarkdownRenderer content={step.text} onImageClick={onImageClick} />
          : <div className={s.status}>{generating && current === step.text && index === steps.length - 1 && <span className={s.spinner} />}<span>{step.text}</span></div>}
      </div>)}{generating && draft && <div className={s.entry}><MarkdownRenderer content={draft} onImageClick={onImageClick} /></div>}
      {generating && current && !steps.some(step=>step.type==='tool'&&step.call.running) && steps.at(-1)?.type !== 'activity' && <div className={s.status} role="status"><span className={s.spinner}/>{current}</div>}</div>
    </details>

  </div>;
}
