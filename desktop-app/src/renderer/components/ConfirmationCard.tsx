import React, { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatedDetails } from './AnimatedDisclosure';
import { EmailBodyPreview } from './EmailBodyPreview';
import { FileEditDiff } from './FileEditDiff/FileEditDiff';
import s from './ConfirmationCard.module.scss';
import { projectConfirmation } from '../lib/confirmation-projection';
import type { ConfirmationBridgeApi } from '../lib/useConfirmationBridge';

export type ConfirmationComment = {
  id: string; title: string; text: string;
  reject: (comment: string) => Promise<void> | void;
};
export type ConfirmationComposer = {
  comment: ConfirmationComment | null;
  request: (target: Omit<ConfirmationComment, 'text'>) => void;
  change: (text: string) => void;
  cancel: () => void;
  submit: () => Promise<void>;
  busy: boolean;
  registerReject: (id: string, reject: ConfirmationComment['reject']) => () => void;
};
type CardContextValue = {
  busy: boolean;
  run: (action: () => Promise<void> | void) => Promise<void>;
  requestComment: (reject: ConfirmationComment['reject']) => void;
  expanded: boolean;
  registerReject: (reject: ConfirmationComment['reject']) => (() => void) | undefined;
};
export const ConfirmationCardContext = createContext<CardContextValue | null>(null);
const ComposerContext = createContext<ConfirmationComposer | null>(null);
const BridgeContext = createContext<{ api: ConfirmationBridgeApi; custom: boolean } | null>(null);

export function ConfirmationCommentInput({ composer, modal = false }: { composer: ConfirmationComposer; modal?: boolean }) {
  const { t } = useTranslation();
  if (!composer.comment) return null;
  return <div className={s.comment}>
    <div className={s.commentHeading}><span>{t('chat.approvals.commentFor', { title: composer.comment.title })}</span>
      <button type="button" disabled={composer.busy} onClick={composer.cancel}>{t('common.cancel')}</button></div>
    {modal && <textarea autoFocus rows={3} value={composer.comment.text} disabled={composer.busy}
      placeholder={t('review.commentPlaceholder')} aria-label={t('review.commentPlaceholder')}
      onChange={e => composer.change(e.target.value)} />}
    <button type="button" className={s.primary} disabled={composer.busy || !composer.comment.text.trim()}
      onClick={() => void composer.submit()}>{composer.busy ? t('common.sending') : t('chat.approvals.rejectAndSend')}</button>
  </div>;
}

type CardProps = {
  id: string; title: string; summary?: string; icon?: ReactNode; children: ReactNode;
  actions: ReactNode; extraActions?: ReactNode; reviewAction?: ReactNode; expandable?: boolean; expandLabel?: string; fullScreen?: boolean;
  queueControl?: ReactNode; onBusyChange?: (busy: boolean) => void;
};

export function ConfirmationCard({ id, title, summary = '', icon, children, actions, extraActions, reviewAction, expandable, expandLabel, fullScreen, queueControl, onBusyChange }: CardProps) {
  const { t } = useTranslation();
  const composer = useContext(ComposerContext);
  const bridge = useContext(BridgeContext);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const run = async (action: () => Promise<void> | void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); onBusyChange?.(true);
    try { await action(); }
    finally { busyRef.current = false; setBusy(false); onBusyChange?.(false); }
  };
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      if (event.key === 'Tab') {
        const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),iframe,a[href]') || []).filter(n => n.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyDown, true);
    return () => { document.removeEventListener('keydown', keyDown, true); if (previous?.isConnected) previous.focus(); else requestAnimationFrame(() => expandRef.current?.focus()); };
  }, [expanded]);

  // Native action buttons keep their existing callbacks and visual styles.
  const bindActions = (nodes: ReactNode): ReactNode => React.Children.map(nodes, child => {
    if (!React.isValidElement(child)) return child;
    const element = child as ReactElement<any>;
    if (element.type === 'button' && element.props.onClick) {
      const click = element.props.onClick;
      return React.cloneElement(element, {
        disabled: busy || element.props.disabled,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => { void run(() => click(event)).catch(() => {}); },
      });
    }
    return element.props.children ? React.cloneElement(element, {}, bindActions(element.props.children)) : element;
  });
  const context: CardContextValue = {
    busy, run, expanded,
    requestComment: reject => composer?.request({ id, title, reject: text => run(() => reject(text)) }),
    registerReject: reject => composer?.registerReject(id, text => run(() => reject(text))),
  };
  const projection = bridge ? projectConfirmation(children, { primary: actions, permissions: extraActions, review: reviewAction },
    { reject: t('review.reject'), rejectWithComment: t('review.rejectWithComment') }, busy) : undefined;
  useLayoutEffect(() => {
    if (!bridge || !projection) return;
    bridge.api.register({ id, title, summary, busy, customizable: projection.customizable,
      content: projection.content, fields: projection.fields, actions: projection.actions },
    { commands: projection.commands, changes: projection.changes, run, busy: () => busyRef.current });
  });
  useLayoutEffect(() => () => bridge?.api.remove(id), [bridge?.api, id]);
  const card = <ConfirmationCardContext.Provider value={context}>
    <section className={`${s.card} ${expanded ? s.expanded : ''}`} data-confirmation-id={id} data-confirmation-expanded={expanded || undefined}>
      <div className={s.header}>
        <div className={s.title} id={titleId}>{icon}<span>{title}</span></div>
        <div className={s.headerActions}>{!expanded && queueControl}
          {expandable && <button ref={expandRef} type="button" className={s.iconButton} onClick={() => setExpanded(value => !value)}
            aria-label={expanded ? t('common.close') : (expandLabel || t('chat.approvals.expandEmail'))} title={expanded ? t('common.close') : (expandLabel || t('chat.approvals.expandEmail'))}>
            {expanded ? '✕' : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" /></svg>}
          </button>}
        </div>
      </div>
      <div className={s.content}>{children}</div>
      <div className={s.footer}>
        <div className={s.actions}>{bindActions(actions)}{bindActions(reviewAction)}</div>
        {extraActions && <AnimatedDetails summary={t('chat.approvals.permissions')} className={s.permissions} locked={busy}>
          <div className={s.actions}>{bindActions(extraActions)}</div>
        </AnimatedDetails>}
        {busy && <div role="status" className={s.status}>{t('chat.confirm.executing')}</div>}
        {expanded && composer?.comment?.id === id && <ConfirmationCommentInput composer={composer} modal />}
      </div>
    </section>
  </ConfirmationCardContext.Provider>;
  if (bridge?.custom) return null;
  return expanded ? createPortal(<div className={`${s.overlay} ${fullScreen ? s.fullScreen : ''}`} onClick={() => setExpanded(false)}>
    <div ref={panelRef} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e => e.stopPropagation()}>{card}</div>
  </div>, document.body) : card;
}

export function ConfirmationFileDiff({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const expanded = useContext(ConfirmationCardContext)?.expanded;
  return <FileEditDiff oldContent={oldContent} newContent={newContent} expanded={expanded} />;
}

export function ConfirmationEmailBody({ body }: { body: string }) {
  const expanded = useContext(ConfirmationCardContext)?.expanded;
  return <div className={expanded ? s.emailFull : s.emailPreview}>
    <EmailBodyPreview body={body} maxHeight={expanded ? 100000 : 600} />
  </div>;
}

export function confirmationCardId(item: ReactElement<any>): string {
  return item.props.id ?? item.props.proposal?.proposal_id ?? String(item.key);
}

export function ConfirmationQueue({ items, order, composer, request, bridge, custom = false }: {
  items: ReactElement<CardProps>[]; order: Map<string, number>; composer: ConfirmationComposer; request?: { id: string } | null;
  bridge?: ConfirmationBridgeApi; custom?: boolean;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consumedRequest = useRef<typeof request>();
  const ordered = [...items].sort((a, b) => (order.get(confirmationCardId(a)) ?? Infinity) - (order.get(confirmationCardId(b)) ?? Infinity));
  const active = ordered.find(item => confirmationCardId(item) === selected) || ordered[0];
  useEffect(() => {
    if (!request || consumedRequest.current === request || busy || composer.busy) return;
    consumedRequest.current = request;
    composer.cancel();
    setSelected(request.id);
  }, [request, busy, composer.busy]);
  useEffect(() => { setBusy(false); }, [active && confirmationCardId(active)]);
  if (!active) return null;
  const control = <select className={s.queueSelect} value={confirmationCardId(active)} disabled={busy || composer.busy}
    aria-label={t('chat.approvals.queue', { count: items.length })} onChange={e => { composer.cancel(); setSelected(e.target.value); }}>
    {ordered.map((item, index) => <option key={confirmationCardId(item)} value={confirmationCardId(item)}>{index + 1}/{items.length} · {item.props.title ?? (item.props as any).proposal?.profile?.name ?? confirmationCardId(item)}{item.props.summary ? ` — ${item.props.summary}` : ''}</option>)}
  </select>;
  const renderCard = (item: ReactElement<CardProps>) => React.cloneElement(item, { key: confirmationCardId(item),
    queueControl: control, onBusyChange: confirmationCardId(item) === confirmationCardId(active) ? setBusy : undefined });
  return <ComposerContext.Provider value={composer}><BridgeContext.Provider value={bridge ? { api: bridge, custom } : null}>
    {bridge ? ordered.map(item => <div key={confirmationCardId(item)} hidden={confirmationCardId(item) !== confirmationCardId(active)}>{renderCard(item)}</div>) : renderCard(active)}
  </BridgeContext.Provider></ComposerContext.Provider>;
}
