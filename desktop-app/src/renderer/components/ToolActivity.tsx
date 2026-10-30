import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '../lib/api';
import { describeToolCall, groupToolActivities, toolValue, type ActivityKind, type ToolActivity as Activity } from '../lib/tool-activity';
import s from './ToolActivity.module.scss';

const paths: Record<ActivityKind, ReactNode> = {
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  avatar: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 9h.01M16 9h.01M8 15q4 4 8 0" /></>,
  tool: <><path d="m14.7 6.3 3 3M3 21l7-7m-2-4a6 6 0 0 1 8-8l-4 4 4 4 4-4a6 6 0 0 1-8 8L5 21H3v-2l7-7" /></>,
};
function Icon({ kind }: { kind: ActivityKind }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
function Chevron() {
  return <svg className={s.chevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>;
}
export function ToolActivityCall({ call }: { call: ToolCall }) {
  return <ActionRow row={describeToolCall(call)} />;
}

function ActionRow({ row }: { row: Activity }) {
  const { t } = useTranslation();
  const label = t(`toolActivity.names.${row.call.name}`, { defaultValue: row.call.name });
  const failed = row.status === 'error';
  return <details className={`${s.action} ${failed ? s.failed : row.confirmed ? s.confirmed : ''}`}>
    <summary>
      <Icon kind={row.kind} />
      <span className={s.label}>{failed ? t('toolActivity.failed', { action: label }) : label}</span>
      {row.target && <span className={s.target} title={row.target}>{row.target}</span>}
      <span className={s.status} title={row.call.running ? undefined : t(`toolActivity.${row.status}`)}>
        {row.call.running ? <span className={s.spinner} /> : row.status === 'returned' ? '✓' : failed ? '!' : '·'}
      </span>
      <Chevron />
    </summary>
    <div className={s.detail}>
      <div className={s.rawName}>{row.call.name}</div>
      <div className={s.detailLabel}>{t('chat.message.arguments')}</div>
      <pre>{toolValue(row.call.arguments) || '{}'}</pre>
      <div className={s.detailLabel}>{t('chat.message.result')}</div>
      <pre>{toolValue(row.call.result_preview) || t('toolActivity.noResult')}</pre>
    </div>
  </details>;
}

export function ToolActivity({ calls = [], current, expanded, onToggle }: {
  calls?: ToolCall[] | null; current?: string | null; expanded: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { visible, more, internal } = groupToolActivities(calls ?? []);
  if (!current && !calls?.length) return null;
  return <div className={s.activity}>
    {current && <div className={s.current} role="status"><span className={s.spinner} /><span>{current}</span></div>}
    {visible.map((row, i) => <ActionRow key={row.call.id || `visible-${i}`} row={row} />)}
    {more.length > 0 && <>
      <button type="button" className={s.more} aria-expanded={expanded} onClick={onToggle}>
        <Chevron />{expanded ? t('toolActivity.collapse') : t('toolActivity.more', { count: more.length })}
      </button>
      {expanded && more.map((row, i) => <ActionRow key={row.call.id || `more-${i}`} row={row} />)}
    </>}
    {internal.length > 0 && <details className={s.internal}>
      <summary><Chevron />{t('toolActivity.internal', { count: internal.length })}</summary>
      <div className={s.internalBody}>{internal.map((row, i) => <ActionRow key={row.call.id || `internal-${i}`} row={row} />)}</div>
    </details>}
  </div>;
}
