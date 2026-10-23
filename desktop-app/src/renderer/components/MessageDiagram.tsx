import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ELK from 'elkjs/lib/elk-api.js';
import { diagramToText, parseMessageDiagram, type MessageDiagram as DiagramData } from '../lib/message-accents';
import { layoutDiagram, type DiagramLayout } from '../lib/diagram-layout';
import s from './MessageDiagram.module.scss';

export function MessageDiagram({ source, closed }: { source: string; closed: boolean }) {
  const { t } = useTranslation();
  const diagram = useMemo(() => { try { return parseMessageDiagram(source); } catch { return null; } }, [source]);
  if (!closed) return <p role="status">{t('diagram.waiting')}</p>;
  if (!diagram) return <section className={s.card}><p role="alert">{t('diagram.invalid')}</p><pre><code>{source}</code></pre></section>;
  return <Diagram key={source} source={source} diagram={diagram} />;
}

function Diagram({ source, diagram }: { source: string; diagram: DiagramData }) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<DiagramLayout | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLElement>(null), dialog = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const title = diagram.title || t(`diagram.${diagram.type}`);
  useEffect(() => {
    let worker: Worker | undefined, timeout: ReturnType<typeof setTimeout> | undefined, disposed = false, started = false;
    const start = () => {
      if (started || disposed) return;
      started = true;
      try {
        worker = new Worker(new URL('../lib/diagram-layout.worker.ts', import.meta.url), { type: 'module' });
        timeout = setTimeout(() => { worker?.terminate(); if (!disposed) setFailed(true); }, 10_000);
        const engine = new ELK({ workerFactory: () => worker! });
        void layoutDiagram(diagram, engine).then(result => {
          clearTimeout(timeout); worker?.terminate();
          if (disposed) return;
          if (result && Number.isFinite(result.width) && Number.isFinite(result.height) && result.width > 0 && result.height > 0) setLayout(result);
          else setFailed(true);
        }).catch(() => { clearTimeout(timeout); worker?.terminate(); if (!disposed) setFailed(true); });
        worker.addEventListener('error', () => { clearTimeout(timeout); worker?.terminate(); if (!disposed) setFailed(true); });
      } catch { setFailed(true); }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { observer?.disconnect(); start(); } }, { rootMargin: '300px' });
    if (observer && root.current) observer.observe(root.current); else start();
    return () => { disposed = true; observer?.disconnect(); clearTimeout(timeout); worker?.terminate(); };
  }, [diagram]);
  useEffect(() => {
    if (!expanded) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setExpanded(false); }
      if (event.key === 'Tab') {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', keydown, true); expandButton.current?.focus({ preventScroll: true }); };
  }, [expanded]);
  const picture = (large = false) => layout ? <DiagramCanvas diagram={diagram} layout={layout} large={large} />
    : <p role={failed ? 'alert' : 'status'}>{t(failed ? 'diagram.failed' : 'diagram.loading')}</p>;
  return <>
    <section className={s.card} ref={root} data-message-diagram>
      <div className={s.toolbar}><strong>{title}</strong><div>
        <button type="button" onClick={() => setCode(v => !v)}>{t(code ? 'diagram.preview' : 'diagram.code')}</button>
        <button type="button" onClick={() => { void navigator.clipboard.writeText(source).then(() => setCopied(true)).catch(() => {}); }}>{t(copied ? 'diagram.copied' : 'common.copy')}</button>
        <button ref={expandButton} type="button" disabled={!layout} onClick={() => setExpanded(true)}>{t('diagram.expand')}</button>
      </div></div>
      {code || failed ? <pre><code>{source}</code></pre> : picture()}
      {failed && <p role="alert">{t('diagram.failed')}</p>}
      {diagram.caption && <p className={s.caption}>{diagram.caption}</p>}
    </section>
    {expanded && createPortal(<div className={s.overlay} onMouseDown={event => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <div className={s.dialog} ref={dialog} role="dialog" aria-modal="true" aria-label={title}>
        <div className={s.toolbar}><strong>{title}</strong><button ref={closeButton} type="button" onClick={() => setExpanded(false)}>{t('common.close')}</button></div>
        {picture(true)}
        {diagram.caption && <p className={s.caption}>{diagram.caption}</p>}
      </div>
    </div>, document.body)}
  </>;
}

function DiagramCanvas({ diagram, layout, large }: { diagram: DiagramData; layout: DiagramLayout; large: boolean }) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 420 });
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const marker = `diagram-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const fit = Math.min(1, size.width / layout.width, size.height / layout.height);
  const zoom = manualZoom ?? fit;
  const colors = { blue: '#3b82f6', green: '#10b981', purple: '#a78bfa', orange: '#f59e0b', red: '#f87171', cyan: '#06b6d4', neutral: '#94a3b8' };
  return <div className={`${s.canvas} ${large ? s.large : ''}`}>
    <div className={s.tools}>
      <button type="button" aria-label={t('diagram.zoomOut')} onClick={() => setManualZoom(Math.max(.1, zoom / 1.25))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label={t('diagram.zoomIn')} onClick={() => setManualZoom(Math.min(3, zoom * 1.25))}>+</button>
      <button type="button" onClick={() => { setManualZoom(null); viewport.current?.scrollTo(0, 0); }}>{t('diagram.fit')}</button>
    </div>
    <div className={s.viewport} ref={viewport} tabIndex={0} aria-label={t('diagram.navigation')}
      onPointerDown={event => { if (event.button !== 0) return; const node = event.currentTarget; drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }; node.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { const state = drag.current; if (state) { event.currentTarget.scrollLeft = state.left - event.clientX + state.x; event.currentTarget.scrollTop = state.top - event.clientY + state.y; } }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <svg role="img" aria-label={diagram.title || t(`diagram.${diagram.type}`)} width={Math.max(1, layout.width * zoom)} height={Math.max(1, layout.height * zoom)} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <desc>{diagramToText(diagram)}</desc>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10" fill="var(--text-muted, #94a3b8)" /></marker></defs>
        {layout.edges.map(edge => <g key={edge.id}>{edge.sections.map((section, i) => <polyline key={i} points={[section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--text-muted, #94a3b8)" strokeWidth="2" markerEnd={i === edge.sections.length - 1 ? `url(#${marker})` : undefined} />)}
          {edge.labels.map((label, i) => <g key={i}><rect x={label.x} y={label.y} width={label.width} height={label.height} rx="8" className={s.edgeLabel} /><text textAnchor="middle" className={s.edgeText}>{label.lines.map((line, j) => <tspan key={j} x={label.x + label.width / 2} y={label.y + 16 + j * 16}>{line}</tspan>)}</text></g>)}
        </g>)}
        {layout.nodes.map(node => {
          const model = diagram.nodes.find(n => n.id === node.id)!;
          const titleHeight = node.titleLines.length * 20, subtitleHeight = node.subtitleLines.length * 16;
          const top = (node.height - titleHeight - subtitleHeight - (subtitleHeight ? 8 : 0)) / 2;
          return <g key={node.id} transform={`translate(${node.x} ${node.y})`} style={{ '--diagram-color': colors[model.color] } as React.CSSProperties}>
            {model.shape === 'decision' ? <polygon className={s.node} points={`${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}`} />
              : <rect className={s.node} width={node.width} height={node.height} rx={model.shape === 'terminal' ? node.height / 2 : 16} />}
            {node.titleLines.map((line, i) => <text className={s.nodeTitle} key={`t${i}`} x={node.width / 2} y={top + 15 + i * 20} textAnchor="middle">{line}</text>)}
            {node.subtitleLines.map((line, i) => <text className={s.nodeSubtitle} key={`s${i}`} x={node.width / 2} y={top + titleHeight + 8 + 12 + i * 16} textAnchor="middle">{line}</text>)}
          </g>;
        })}
      </svg>
    </div>
  </div>;
}
