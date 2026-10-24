/** Canonical source. Run scripts/sync-message-accents.mjs after editing. */
export const MESSAGE_ACCENT_STYLES = [
  'muted', 'caption', 'underline', 'info', 'success', 'warning', 'error',
  'highlight-info', 'highlight-success', 'highlight-warning', 'highlight-error',
  'badge-info', 'badge-success', 'badge-warning', 'badge-error',
] as const;

export type MessageAccentStyle = typeof MESSAGE_ACCENT_STYLES[number];
const styles = new Set<string>(MESSAGE_ACCENT_STYLES);

export type MessageLayoutTag = {
  name: 'grid' | 'flex' | 'box';
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
};

/** A small declarative grammar, not HTML/JSX. Unknown attributes reject the tag. */
export function parseMessageLayoutTag(source: string): MessageLayoutTag | null {
  if (source.length > 400) return null;
  const tag = /^<(\/?)(grid|flex|box)\b([^<>]*?)(\/?)>$/.exec(source.trim());
  if (!tag || (tag[1] && (tag[3].trim() || tag[4]))) return null;
  const name = tag[2] as MessageLayoutTag['name'];
  const attributes: Record<string, string> = {};
  let rest = tag[3];
  while (rest.trim()) {
    const attr = /^\s+([a-z]+)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'))?/.exec(rest);
    if (!attr || Object.prototype.hasOwnProperty.call(attributes, attr[1])) return null;
    const key = attr[1], value = attr[2] ?? attr[3] ?? '';
    const valid = key === 'border' ? value === ''
      : key === 'columns' ? name === 'grid' && /^[1-4]$/.test(value)
      : key === 'gap' || key === 'padding' ? /^[0-6]$/.test(value)
      : key === 'radius' ? /^(none|sm|md|lg|xl)$/.test(value)
      : key === 'background' ? /^(surface|muted|info|success|warning|error|#[0-9a-fA-F]{6})$/.test(value)
      : key === 'direction' ? name === 'flex' && /^(row|column)$/.test(value)
      : key === 'wrap' ? name === 'flex' && /^(yes|no)$/.test(value)
      : key === 'align' ? /^(start|center|end|stretch)$/.test(value)
      : key === 'justify' ? name === 'flex' && /^(start|center|end|between)$/.test(value)
      : false;
    if (!valid) return null;
    attributes[key] = value;
    rest = rest.slice(attr[0].length);
  }
  return { name, closing: !!tag[1], selfClosing: !!tag[4], attributes };
}

export type DiagramNode = { id: string; title: string; subtitle?: string; color: 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'cyan' | 'neutral'; shape: 'action' | 'decision' | 'terminal' };
export type MessageDiagram = { type: 'architecture' | 'flowchart'; direction: 'down' | 'right'; title?: string; caption?: string; nodes: DiagramNode[]; edges: Array<{ from: string; to: string; label?: string }> };

/** A diagram is data only: never forward model properties to SVG or the layout engine. */
export function parseMessageDiagram(source: string): MessageDiagram {
  const fail = (): never => { throw new Error('diagram_invalid'); };
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) return fail();
    return v as Record<string, unknown>;
  };
  const string = (v: unknown, max: number): string => typeof v === 'string' && !!v.trim() && v.length <= max ? v.trim() : fail();
  const id = (v: unknown) => { const s = string(v, 64); return /^[a-zA-Z0-9_-]+$/.test(s) ? s : fail(); };
  if (source.length > 50_000) return fail();
  const raw = object(JSON.parse(source), ['type', 'direction', 'title', 'caption', 'nodes', 'edges']);
  const type = raw.type ?? 'flowchart', direction = raw.direction ?? 'down';
  if ((type !== 'flowchart' && type !== 'architecture') || (direction !== 'down' && direction !== 'right')) return fail();
  if (!Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 40 || !Array.isArray(raw.edges) || raw.edges.length > 80) return fail();
  const ids = new Set<string>();
  const nodes = raw.nodes.map((value): DiagramNode => {
    const n = object(value, ['id', 'title', 'subtitle', 'color', 'shape']);
    const nodeId = id(n.id);
    if (ids.has(nodeId)) return fail();
    ids.add(nodeId);
    const color = n.color ?? 'blue', shape = n.shape ?? 'action';
    if (!['blue', 'green', 'purple', 'orange', 'red', 'cyan', 'neutral'].includes(color as string) || !['action', 'decision', 'terminal'].includes(shape as string)) return fail();
    return { id: nodeId, title: string(n.title, 80), ...(n.subtitle === undefined ? {} : { subtitle: string(n.subtitle, 120) }), color: color as DiagramNode['color'], shape: shape as DiagramNode['shape'] };
  });
  const edges = raw.edges.map(value => {
    const e = object(value, ['from', 'to', 'label']);
    const from = id(e.from), to = id(e.to);
    if (!ids.has(from) || !ids.has(to)) return fail();
    return { from, to, ...(e.label === undefined ? {} : { label: string(e.label, 60) }) };
  });
  return { type, direction, ...(raw.title === undefined ? {} : { title: string(raw.title, 200) }), ...(raw.caption === undefined ? {} : { caption: string(raw.caption, 500) }), nodes, edges };
}

export function diagramToText(diagram: MessageDiagram): string {
  const nodes = new Map(diagram.nodes.map(n => [n.id, n]));
  return [diagram.title, ...diagram.nodes.map(n => `${n.title}${n.subtitle ? ' — ' + n.subtitle : ''}`),
    ...diagram.edges.map(e => `${nodes.get(e.from)!.title} → ${nodes.get(e.to)!.title}${e.label ? ' (' + e.label + ')' : ''}`), diagram.caption].filter(Boolean).join('\n');
}

export const CHART_COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'cyan', 'neutral', 'pink'] as const;
export type ChartColor = typeof CHART_COLORS[number];
export type MessageChart = {
  type: 'line' | 'bar' | 'area' | 'pie' | 'donut'; title?: string; caption?: string;
  xLabel?: string; yLabel?: string; unit?: string; stacked: boolean;
  labels: string[]; series: Array<{ name: string; color: ChartColor; values: Array<number | null> }>;
};

/** Only bounded data. Never pass arbitrary model options or property names to Recharts. */
export function parseMessageChart(source: string): MessageChart {
  const fail = (): never => { throw new Error('chart_invalid'); };
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) return fail();
    return v as Record<string, unknown>;
  };
  const string = (v: unknown, max: number): string => typeof v === 'string' && !!v.trim() && v.length <= max ? v.trim() : fail();
  if (source.length > 200_000) return fail();
  const raw = object(JSON.parse(source), ['type', 'title', 'caption', 'xLabel', 'yLabel', 'unit', 'stacked', 'labels', 'series']);
  const type = raw.type ?? 'line';
  if (!['line', 'bar', 'area', 'pie', 'donut'].includes(type as string)) return fail();
  const polar = type === 'pie' || type === 'donut';
  if (raw.stacked !== undefined && typeof raw.stacked !== 'boolean') return fail();
  const stacked = raw.stacked === true;
  if (stacked && type !== 'bar' && type !== 'area') return fail();
  if (!Array.isArray(raw.labels) || !raw.labels.length || raw.labels.length > (polar ? 32 : 500)) return fail();
  const labels = raw.labels.map(v => string(v, 100));
  if (new Set(labels).size !== labels.length) return fail();
  if (!Array.isArray(raw.series) || !raw.series.length || raw.series.length > (polar ? 1 : 8)) return fail();
  const names = new Set<string>();
  const series = raw.series.map((value, i) => {
    const item = object(value, ['name', 'color', 'values']);
    const name = string(item.name, 80), color = item.color ?? CHART_COLORS[i];
    if (names.has(name) || !CHART_COLORS.includes(color as ChartColor)) return fail();
    names.add(name);
    if (!Array.isArray(item.values) || item.values.length !== labels.length) return fail();
    const values = item.values.map(v => {
      if (v === null && !polar) return null;
      return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15 && (!polar || v >= 0) ? v : fail();
    });
    if (!values.some(v => v !== null && (!polar || v > 0))) return fail();
    return { name, color: color as ChartColor, values };
  });
  return { type: type as MessageChart['type'], stacked, labels, series,
    ...(raw.title === undefined ? {} : { title: string(raw.title, 200) }),
    ...(raw.caption === undefined ? {} : { caption: string(raw.caption, 500) }),
    ...(raw.xLabel === undefined ? {} : { xLabel: string(raw.xLabel, 80) }),
    ...(raw.yLabel === undefined ? {} : { yLabel: string(raw.yLabel, 80) }),
    ...(raw.unit === undefined ? {} : { unit: string(raw.unit, 20) }) };
}

export function chartToText(chart: MessageChart): string {
  return [chart.title, [chart.xLabel, chart.yLabel].filter(Boolean).join(' / '),
    ...chart.labels.map((label, i) => `${label}: ${chart.series.map(s => `${s.name}: ${s.values[i] === null ? '—' : s.values[i]}${s.values[i] !== null && chart.unit ? ' ' + chart.unit : ''}`).join('; ')}`), chart.caption].filter(Boolean).join('\n');
}

export function getMessageAccentStyle(url: string): MessageAccentStyle | null {
  const style = url.startsWith('style:') ? url.slice(6) : '';
  return styles.has(style) ? style as MessageAccentStyle : null;
}

/** Plain Markdown fallback, including image layout titles. Code stays literal. */
export function stripMessageAccents(source: string): string {
  return transformMessageAccents(source, true);
}

/** Hide an unfinished style destination while tokens are arriving. */
export function prepareMessageAccents(source: string): string {
  return transformMessageAccents(source, false);
}

function transformMessageAccents(source: string, stripComplete: boolean): string {
  if (!source.includes('](style') && !(stripComplete && (source.includes('layout:') || source.includes('questionnaire') || source.includes('diagram') || source.includes('chart')))
    && !/<\/?(?:grid|flex|box)\b/.test(source)) return source;
  let result = '';
  let index = 0;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(index));
      if (fence) {
        const end = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
        end.lastIndex = index + fence[0].length;
        const closing = end.exec(source);
        const stop = closing ? end.lastIndex : source.length;
        let literal = source.slice(index, stop);
        if (stripComplete && closing && /^ {0,3}(?:`{3,}|~{3,})diagram[ \t]*\r?\n/.test(fence[0])) {
          try { literal = diagramToText(parseMessageDiagram(source.slice(index + fence[0].length, closing.index))) + '\n'; }
          catch { /* Invalid diagrams remain literal code. */ }
        }
        if (stripComplete && closing && /^ {0,3}(?:`{3,}|~{3,})chart[ \t]*\r?\n/.test(fence[0])) {
          try { literal = chartToText(parseMessageChart(source.slice(index + fence[0].length, closing.index))) + '\n'; }
          catch { /* Invalid charts remain literal code. */ }
        }
        // Telegram/plain fallback only. No new bot runtime dependency or executable markup.
        if (stripComplete && closing && /^ {0,3}(?:`{3,}|~{3,})questionnaire[ \t]*\r?\n/.test(fence[0])) {
          try {
            const form = JSON.parse(source.slice(index + fence[0].length, closing.index));
            if (typeof form.title === 'string' && Array.isArray(form.questions) && form.questions.length <= 100
              && form.questions.every((q: any) => typeof q?.label === 'string' && ['single', 'multiple', 'text', 'textarea'].includes(q.type)
                && (q.options === undefined || (Array.isArray(q.options) && q.options.length <= 32 && q.options.every((v: any) => typeof v === 'string'))))) {
              literal = form.title + '\n\n' + form.questions.map((q: any, n: number) => `${n + 1}. ${q.label}${q.required ? ' *' : ''}`
                + (typeof q.image?.url === 'string' && q.image.url.length <= 2048 && /^(?:https?:\/\/|\/(?!\/))/.test(q.image.url) && !/[\s\\\u0000-\u001f\u007f]/u.test(q.image.url) ? '\nImage: ' + q.image.url : '')
                + (q.options?.length ? '\n' + q.options.map((o: string) => `- ${o}`).join('\n') : '')
                + (q.allowOther === true && (q.type === 'single' || q.type === 'multiple') ? '\n- Other (free text)' : '')).join('\n\n') + '\n';
            }
          } catch { /* Invalid JSON stays literal code. */ }
        }
        result += literal;
        index = stop;
        continue;
      }
      // Standalone tags get blank lines so Markdown inside containers stays Markdown.
      const layoutLine = /^ {0,3}(<\/?(?:grid|flex|box)\b[^\r\n]*>)[ \t]*(?:\r?\n|$)/.exec(source.slice(index));
      if (layoutLine && parseMessageLayoutTag(layoutLine[1])) {
        result += stripComplete ? '\n' : `\n\n${layoutLine[1]}\n\n`;
        index += layoutLine[0].length;
        continue;
      }
    }
    if (source[index] === '\\') {
      result += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (source[index] === '`') {
      const delimiter = /^`+/.exec(source.slice(index))![0];
      const runs = /`+/g;
      runs.lastIndex = index + delimiter.length;
      let match: RegExpExecArray | null;
      let stop = 0;
      while ((match = runs.exec(source))) {
        if (match[0].length === delimiter.length) { stop = runs.lastIndex; break; }
      }
      if (stop) {
        result += source.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (stripComplete && source.startsWith('![', index)) {
      const image = /^(!\[(?:\\.|[^\]\\\r\n])*\]\((?:<[^<>\r\n]+>|[^\s\r\n]+?))[ \t]+(?:"layout:(?:side|gallery)"|'layout:(?:side|gallery)'|\(layout:(?:side|gallery)\))[ \t]*\)/.exec(source.slice(index));
      if (image) {
        result += `${image[1]})`;
        index += image[0].length;
        continue;
      }
    }
    if (source[index] === '[') {
      let depth = 1;
      let end = index + 1;
      for (; end < source.length && source[end] !== '\n'; end++) {
        if (source[end] === '\\') { end++; continue; }
        if (source[end] === '[') depth++;
        if (source[end] === ']' && --depth === 0) break;
      }
      const suffix = depth === 0 ? /^\]\((style:[a-z-]+)\)/.exec(source.slice(end)) : null;
      if (suffix && getMessageAccentStyle(suffix[1])) {
        result += stripComplete ? source.slice(index + 1, end) : source.slice(index, end + suffix[0].length);
        index = end + suffix[0].length;
        continue;
      }
      const pending = depth === 0 ? /^\]\(style(?::([a-z-]*))?$/.exec(source.slice(end)) : null;
      if (pending && MESSAGE_ACCENT_STYLES.some(style => style.startsWith(pending[1] || ''))) {
        result += source.slice(index + 1, end);
        index = source.length;
        continue;
      }
    }
    result += source[index++];
  }
  return result;
}
