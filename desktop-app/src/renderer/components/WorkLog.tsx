import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentTrace, ToolCall, WorkLogStep } from '../lib/api';
import { describeToolCall } from '../lib/tool-activity';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Icon } from './Icon';
import { ToolActivityCall } from './ToolActivity';
import s from './WorkLog.module.scss';
import { AnimatedDetails } from './AnimatedDisclosure';

export function WorkLog({ messages, entries, calls, subagents, showTokens, current, draft, generating, onImageClick }: {
  messages: string[]; entries?: WorkLogStep[]; calls?: ToolCall[] | null;
  subagents?: SubagentTrace[] | null; showTokens?: boolean;
  current?: string | null; draft?: string; generating: boolean; onImageClick?: (src: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!generating) setOpen(false); }, [generating]);
  // Old flat records have no interleaving metadata; retain every available item.
  const steps: WorkLogStep[] = entries?.length ? entries
    : [...messages.map(text => ({ type: 'message' as const, text })), ...(calls ?? []).map(call => ({ type: 'tool' as const, call }))];
  const unmatched = new Set(subagents ?? []);
  const rows = steps.map(step => {
    if (step.type !== 'tool' || !['invoke_subagent', 'spawn_subagent'].includes(step.call.name)) return { step };
    let args = step.call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return { step }; }
    }
    const candidates = [...unmatched].filter(trace => trace.task === args?.task?.trim?.());
    const trace = candidates.length === 1 ? candidates[0] : undefined;
    if (trace) unmatched.delete(trace);
    return { step, trace, task: typeof args?.task === 'string' ? args.task : '', agentName: typeof args?.agent === 'string' ? args.agent : undefined };
  });
  const actionCount = steps.filter(step => step.type !== 'message').length + unmatched.size;
  const errorCount = steps.filter(step => step.type === 'tool' && describeToolCall(step.call).status === 'error').length;
  if (!steps.length && !unmatched.size && !current && !draft) return null;
  return <div className={s.workLog} data-work-log>
    <AnimatedDetails open={generating || open} onOpenChange={setOpen} locked={generating} summary={<>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        <span>{t('workLog.title')}</span>
        {actionCount > 0 && <span className={s.count}>· {t('workLog.actions', { count: actionCount })}</span>}
        {errorCount > 0 && <span className={s.error}>· {t('workLog.errors', { count: errorCount })}</span>}
      </>}>
      <div className={s.entries}>{rows.map(({ step, trace, agentName, task }, index) => <div className={s.entry} key={index}>
        {step.type === 'tool' && (trace || task !== undefined && (step.call.running || step.call.agent_tools?.length)) ? <AgentWork trace={trace} agentName={agentName} showTokens={showTokens} call={step.call} task={task} /> : step.type === 'tool' ? <ToolActivityCall call={step.call} />
          : step.type === 'message' ? <MarkdownRenderer content={step.text} onImageClick={onImageClick} />
          : <div className={s.status}>{generating && current === step.text && index === steps.length - 1 && <span className={s.spinner} />}<span>{step.text}</span></div>}
      </div>)}{[...unmatched].map((trace, index) => <AgentWork key={index} trace={trace} showTokens={showTokens} />)}{generating && draft && <div className={s.entry}><MarkdownRenderer content={draft} onImageClick={onImageClick} /></div>}
      {generating && current && !steps.some(step=>step.type==='tool'&&step.call.running) && steps.at(-1)?.type !== 'activity' && <div className={s.status} role="status"><span className={s.spinner}/>{current}</div>}</div>
    </AnimatedDetails>

  </div>;
}

function AgentWork({ trace, agentName, showTokens, call, task }: {
  trace?: SubagentTrace; agentName?: string; showTokens?: boolean; call?: ToolCall; task?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = trace?.iterations?.reduce((total, iteration) => total + (iteration.tool_calls?.length ?? 0), 0) ?? 0;

  const tools = call?.agent_tools ?? [];
  const current = tools.filter(tool => tool.running);

  return <div className={s.agentRow}><div className={s.agent}>
    <AnimatedDetails open={open} onOpenChange={setOpen} summary={<>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      <Icon name="agent" size={16} />
      <strong>{agentName?.replace(/_/g, ' ') || t('toolActivity.names.spawn_subagent')}</strong>
      <span className={s.count}>{call?.running ? <span className={s.spinner} /> : <>{trace?.aborted ? t('chat.message.interruptedSuffix') : describeToolCall(call ?? { name: '', arguments: {} }).status === 'error' ? '!' : '✓'} · {t('workLog.actions', { count: trace ? count : tools.length })}</>}</span>
    </>}>
      <div className={s.entries}>
        <div><strong>{t('chat.message.task')}</strong><MarkdownRenderer content={trace?.task || task || ''} /></div>
        {!trace && tools.map(tool => <ToolActivityCall key={tool.id} call={tool} />)}
        {trace?.iterations?.map((iteration, index) => <div className={s.agentSteps} key={index}>
          {iteration.content && !iteration.is_final && iteration.content !== trace.answer && <MarkdownRenderer content={iteration.content} />}
          {iteration.tool_calls?.map((call, callIndex) => {
            const result = call.id
              ? iteration.results?.find(item => item.id === call.id)
              : iteration.results?.[callIndex];
            return <ToolActivityCall key={call.id ?? callIndex} call={{ ...call, result_preview: result?.content }} />;
          })}
        </div>)}
        {trace?.answer && <div><strong>{t('chat.message.answer')}</strong><MarkdownRenderer content={trace.answer} /></div>}
        {trace && <details>
          <summary>{t('chat.message.systemPrompt')}</summary>
          <pre className={s.agentPrompt}>{trace.system_prompt}</pre>
          {showTokens && trace.usage?.aggregate && <span>{trace.usage.aggregate.total_tokens.toLocaleString()} tk · {trace.usage.calls?.[0]?.model}</span>}
        </details>}
      </div>
    </AnimatedDetails>
  </div>
    {!open && current.length > 0 && <div className={s.agentCurrent}>{current.map(tool => <ToolActivityCall key={tool.id} call={tool} />)}</div>}
  </div>;
}
