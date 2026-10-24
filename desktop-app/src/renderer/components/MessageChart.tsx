import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Area, Bar, CartesianGrid, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_COLORS, parseMessageChart, type MessageChart as ChartData, type ChartColor } from '../lib/message-accents';
import frame from './MessageDiagram.module.scss';
import s from './MessageChart.module.scss';

const colors: Record<ChartColor, string> = { blue: '#60a5fa', green: '#34d399', purple: '#a78bfa', orange: '#fbbf24', red: '#f87171', cyan: '#22d3ee', neutral: '#94a3b8', pink: '#f472b6' };

export default function MessageChart({ source, closed }: { source: string; closed: boolean }) {
  const { t } = useTranslation();
  const chart = useMemo(() => { try { return parseMessageChart(source); } catch { return null; } }, [source]);
  if (!closed) return <p role="status">{t('chart.waiting')}</p>;
  if (!chart) return <section className={frame.card}><p role="alert">{t('chart.invalid')}</p><pre><code>{source}</code></pre></section>;
  return <Chart key={source} chart={chart} source={source} />;
}

function Chart({ chart, source }: { chart: ChartData; source: string }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<'chart' | 'table' | 'code'>('chart');
  const [expanded, setExpanded] = useState(false), [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState<number[]>([]);
  const dialog = useRef<HTMLDivElement>(null), expandButton = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const title = chart.title || t('chart.title');
  const polar = chart.type === 'pie' || chart.type === 'donut';
  const number = useMemo(() => new Intl.NumberFormat(i18n.language, { maximumSignificantDigits: 17 }), [i18n.language]);
  const valueText = (value: number | null) => value === null ? '—' : `${number.format(value)}${chart.unit ? ' ' + chart.unit : ''}`;
  // Generated keys only: labels/names such as __proto__ must never become data paths.
  const rows = useMemo(() => chart.labels.map((label, i) => Object.fromEntries([
    ['label', label], ...chart.series.map((series, j) => [`v${j}`, series.values[i]]),
  ])), [chart]);
  const slices = useMemo(() => chart.labels.map((name, i) => ({ name, value: chart.series[0].values[i]!, fill: colors[CHART_COLORS[i % CHART_COLORS.length]], index: i })).filter(v => !hidden.includes(v.index)), [chart, hidden]);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setExpanded(false); }
      if (event.key === 'Tab') {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', keydown, true); expandButton.current?.focus({ preventScroll: true }); };
  }, [expanded]);
  const legend = polar ? chart.labels.map((name, i) => ({ name, color: colors[CHART_COLORS[i % CHART_COLORS.length]] })) : chart.series.map(series => ({ name: series.name, color: colors[series.color] }));
  const table = <div className={s.table} tabIndex={0}><table><caption>{title}{chart.unit ? ` (${chart.unit})` : ''}</caption><thead><tr><th scope="col">{chart.xLabel || t('chart.category')}</th>{chart.series.map((series, i) => <th scope="col" key={i}>{series.name}</th>)}</tr></thead><tbody>{chart.labels.map((label, i) => <tr key={i}><th scope="row">{label}</th>{chart.series.map((series, j) => <td key={j}>{valueText(series.values[i])}</td>)}</tr>)}</tbody></table></div>;
  const picture = (large = false) => <div className={`${s.picture} ${large ? s.large : ''}`}>
    {(chart.yLabel || chart.unit) && !polar && <p className={s.axis}>{chart.yLabel}{chart.unit ? ` (${chart.unit})` : ''}</p>}
    <div className={s.plot}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        {polar ? <PieChart accessibilityLayer>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius={chart.type === 'donut' ? '52%' : 0} outerRadius="80%" isAnimationActive={false} stroke="var(--bg-bubble, #101923)" />
          <Tooltip contentStyle={{ background: 'var(--bg-primary, #101923)', border: '1px solid var(--border-light, #334155)', borderRadius: 8, color: 'var(--text-primary, #e2e8f0)', whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 280 }} formatter={value => valueText(Number(value))} />
        </PieChart> : <ComposedChart data={rows} accessibilityLayer margin={{ top: 12, right: 16, bottom: 8, left: 0 }} stackOffset="sign">
          <CartesianGrid stroke="var(--border-light, #334155)" strokeDasharray="3 5" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: 'var(--text-muted, #94a3b8)', fontSize: 12 }} tickFormatter={value => String(value).length > 18 ? String(value).slice(0, 17) + '…' : String(value)} minTickGap={24} tickLine={false} />
          <YAxis width={68} tick={{ fill: 'var(--text-muted, #94a3b8)', fontSize: 12 }} tickFormatter={value => new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value))} tickLine={false} />
          <Tooltip contentStyle={{ background: 'var(--bg-primary, #101923)', border: '1px solid var(--border-light, #334155)', borderRadius: 8, color: 'var(--text-primary, #e2e8f0)', whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 280 }} formatter={value => valueText(Number(value))} />
          {chart.series.map((series, i) => {
            const common = { dataKey: `v${i}`, name: series.name, stroke: colors[series.color], fill: colors[series.color], hide: hidden.includes(i), isAnimationActive: false };
            return chart.type === 'bar' ? <Bar key={i} {...common} stackId={chart.stacked ? 'values' : undefined} maxBarSize={56} />
              : chart.type === 'area' ? <Area key={i} {...common} type="linear" fillOpacity={.18} strokeWidth={2} stackId={chart.stacked ? 'values' : undefined} connectNulls={false} />
              : <Line key={i} {...common} type="linear" strokeWidth={2} dot={chart.labels.length <= 60 ? { r: 3 } : false} activeDot={{ r: 5 }} connectNulls={false} />;
          })}
        </ComposedChart>}
      </ResponsiveContainer>
    </div>
    {chart.xLabel && !polar && <p className={s.axis}>{chart.xLabel}</p>}
    <div className={s.legend} aria-label={t('chart.legend')}>{legend.map((entry, i) => <button type="button" key={i} aria-pressed={!hidden.includes(i)} onClick={() => setHidden(previous => previous.includes(i) ? previous.filter(v => v !== i) : [...previous, i])}><span style={{ backgroundColor: entry.color }} />{entry.name}</button>)}</div>
    {hidden.length === legend.length && <p role="status">{t('chart.allHidden')}</p>}
    {chart.unit && polar && <p className={s.axis}>{chart.unit}</p>}
  </div>;
  return <>
    <section className={frame.card} data-message-chart>
      <div className={frame.toolbar}><strong>{title}</strong><div>
        {(['chart', 'table', 'code'] as const).map(mode => <button type="button" key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{t(`chart.${mode}`)}</button>)}
        <button type="button" onClick={() => { void navigator.clipboard.writeText(source).then(() => setCopied(true)).catch(() => {}); }}>{t(copied ? 'diagram.copied' : 'common.copy')}</button>
        <button type="button" ref={expandButton} onClick={() => setExpanded(true)}>{t('diagram.expand')}</button>
      </div></div>
      {view === 'chart' ? picture() : view === 'table' ? table : <pre><code>{source}</code></pre>}
      {chart.caption && <p className={frame.caption}>{chart.caption}</p>}
    </section>
    {expanded && createPortal(<div className={frame.overlay} onMouseDown={event => { if (event.target === event.currentTarget) setExpanded(false); }}><div ref={dialog} className={frame.dialog} role="dialog" aria-modal="true" aria-label={title}>
      <div className={frame.toolbar}><strong>{title}</strong><button ref={closeButton} type="button" onClick={() => setExpanded(false)}>{t('common.close')}</button></div>
      <div className={s.modalContent}>{picture(true)}{table}{chart.caption && <p className={frame.caption}>{chart.caption}</p>}</div>
    </div></div>, document.body)}
  </>;
}
