import type { ELK, ElkNode } from 'elkjs/lib/elk-api.js';
import { parseMessageDiagram, type MessageDiagram } from './message-accents';

export type LayoutNode = { id: string; x: number; y: number; width: number; height: number; titleLines: string[]; subtitleLines: string[] };
export type LayoutEdge = { id: string; sections: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>; labels: Array<{ x: number; y: number; width: number; height: number; text: string; lines: string[] }> };
export type DiagramLayout = { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[] };

export function wrapDiagramText(text: string, width = 24): string[] {
  const lines: string[] = [];
  const weightOf = (char: string) => /[\u2e80-\uffff]|[\u{10000}-\u{10ffff}]|[MW@ЖШЩЮ]/u.test(char) ? 2 : 1;
  const measure = (value: string) => [...value].reduce((sum, char) => sum + weightOf(char), 0);
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '', used = 0;
    for (const char of paragraph) {
      const weight = weightOf(char);
      if (used + weight > width && line) {
        const space = line.lastIndexOf(' ');
        if (space > 0 && char !== ' ') { lines.push(line.slice(0, space).trimEnd()); line = line.slice(space + 1); used = measure(line); }
        else { lines.push(line.trimEnd()); line = ''; used = 0; }
      }
      if (!line && char === ' ') continue;
      line += char; used += weight;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export async function layoutDiagram(input: MessageDiagram, engine: Pick<ELK, 'layout'>): Promise<DiagramLayout> {
  const diagram = parseMessageDiagram(JSON.stringify(input));
  const lines = new Map(diagram.nodes.map(n => [n.id, { titleLines: wrapDiagramText(n.title), subtitleLines: n.subtitle ? wrapDiagramText(n.subtitle, 28) : [] }]));
  // Internal ids prevent model ids from colliding with the engine root or generated edge ids.
  const ids = new Map(diagram.nodes.map((n, index) => [n.id, `node-${index}`]));
  const graph: ElkNode = { id: 'root', layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': diagram.direction === 'down' ? 'DOWN' : 'RIGHT',
    'elk.edgeRouting': 'ORTHOGONAL', 'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.padding': '[top=24,left=24,bottom=24,right=24]', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  }, children: diagram.nodes.map(n => {
    const l = lines.get(n.id)!;
    const height = Math.max(72, 28 + l.titleLines.length * 20 + l.subtitleLines.length * 16 + (l.subtitleLines.length ? 8 : 0));
    return { id: ids.get(n.id)!, width: n.shape === 'decision' ? 360 : 232, height: n.shape === 'decision' ? height * 2 : height };
  }), edges: diagram.edges.map((e, i) => ({ id: `edge-${i}`, sources: [ids.get(e.from)!], targets: [ids.get(e.to)!],
    labels: e.label ? [{ text: e.label, width: Math.min(260, [...e.label].length * 12 + 16), height: wrapDiagramText(e.label, 28).length * 16 + 8, layoutOptions: { 'elk.edgeLabels.placement': 'HEAD' } }] : [],
  })) };
  {
    const result = await engine.layout(graph);
    const modelIds = new Map([...ids].map(([model, internal]) => [internal, model]));
    const children = new Map(result.children!.map(n => [n.id, n]));
    const outline = (point: { x: number; y: number }, internalId: string) => {
      const model = diagram.nodes.find(n => ids.get(n.id) === internalId)!;
      const node = children.get(internalId)!;
      if (model.shape !== 'decision') return point;
      const cx = node.x! + node.width! / 2, cy = node.y! + node.height! / 2;
      const dx = point.x - cx, dy = point.y - cy;
      const scale = 1 / (Math.abs(dx) / (node.width! / 2) + Math.abs(dy) / (node.height! / 2));
      return { x: cx + dx * scale, y: cy + dy * scale };
    };
    return { width: result.width!, height: result.height!, nodes: result.children!.map(n => ({ id: modelIds.get(n.id)!, x: n.x!, y: n.y!, width: n.width!, height: n.height!, ...lines.get(modelIds.get(n.id)!)! })),
      edges: result.edges!.map(e => ({ id: e.id, sections: (e.sections ?? []).map(section => ({ ...section, startPoint: outline(section.startPoint, e.sources[0]), endPoint: outline(section.endPoint, e.targets[0]) })), labels: (e.labels ?? []).map(l => ({ x: l.x!, y: l.y!, width: l.width!, height: l.height!, text: l.text!, lines: wrapDiagramText(l.text!, 28) })) })) };
  }
}
