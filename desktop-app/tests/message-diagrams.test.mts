import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseMessageDiagram, diagramToText, stripMessageAccents, prepareMessageAccents } = require('../src/renderer/lib/message-accents.ts');
const { layoutDiagram: calculateLayout, wrapDiagramText } = require('../src/renderer/lib/diagram-layout.ts');
const ELK = require('elkjs/lib/elk.bundled.js');
const layoutDiagram = data => calculateLayout(data, new ELK());

const input = { type: 'architecture', direction: 'down', title: 'Web application', nodes: [
  { id: 'client', title: 'Client', subtitle: 'React', color: 'blue' },
  { id: 'api', title: 'API', subtitle: 'Node.js', color: 'purple' },
  { id: 'db', title: 'Database', color: 'green' },
  { id: 'external', title: 'External API', color: 'orange' },
], edges: [{ from: 'client', to: 'api' }, { from: 'api', to: 'db', label: 'Queries' }, { from: 'api', to: 'external' }] };
const parsed = parseMessageDiagram(JSON.stringify(input));
assert.equal(parsed.nodes[0].shape, 'action');
const source = '```diagram\n' + JSON.stringify(input) + '\n```';
assert.equal(prepareMessageAccents(source), source);
assert.match(stripMessageAccents(source), /API → Database \(Queries\)/);
assert.equal(stripMessageAccents('````md\n' + source + '\n````'), '````md\n' + source + '\n````');
assert.match(diagramToText(parsed), /Client — React/);
for (const invalid of [
  { ...input, onClick: 'alert(1)' }, { ...input, type: 'react' }, { ...input, direction: 'arbitrary' },
  { ...input, nodes: [] }, { ...input, nodes: Array(41).fill(input.nodes[0]) },
  { ...input, nodes: [input.nodes[0], input.nodes[0]] },
  { ...input, nodes: [{ ...input.nodes[0], style: { color: 'red' } }] },
  { ...input, nodes: [{ ...input.nodes[0], color: 'url(evil)' }] },
  { ...input, nodes: [{ ...input.nodes[0], title: 'x'.repeat(81) }] },
  { ...input, edges: [{ from: 'client', to: 'missing' }] },
  { ...input, edges: Array(81).fill(input.edges[0]) },
]) assert.throws(() => parseMessageDiagram(JSON.stringify(invalid)));
assert.throws(() => parseMessageDiagram('x'.repeat(50001)));
const malicious = parseMessageDiagram(JSON.stringify({ nodes: [{ id: '__proto__', title: '<script>alert(1)</script>' }], edges: [] }));
assert.equal(malicious.nodes[0].title, '<script>alert(1)</script>', 'labels remain literal strings');
assert.equal(stripMessageAccents('```diagram\n{bad}\n```'), '```diagram\n{bad}\n```');

function check(layout) {
  assert.ok(Number.isFinite(layout.width) && layout.width > 0);
  assert.ok(Number.isFinite(layout.height) && layout.height > 0);
  for (const n of layout.nodes) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(n[key]));
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
    const a = layout.nodes[i], b = layout.nodes[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'blocks do not overlap');
  }
  for (const e of layout.edges) {
    assert.ok(e.sections.length, 'each edge is routed');
    for (const section of e.sections) for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
}
const architecture = await layoutDiagram(parsed); check(architecture);
assert.ok(architecture.nodes.find(n => n.id === 'client').y < architecture.nodes.find(n => n.id === 'api').y);
assert.ok(architecture.nodes.find(n => n.id === 'api').y < architecture.nodes.find(n => n.id === 'db').y);
const horizontal = await layoutDiagram({ ...parsed, direction: 'right' }); check(horizontal);
assert.ok(horizontal.nodes.find(n => n.id === 'client').x < horizontal.nodes.find(n => n.id === 'api').x);
const flow = parseMessageDiagram(JSON.stringify({ type: 'flowchart', nodes: [
  { id: 'works', title: 'Работает?', shape: 'decision' }, { id: 'release', title: 'Релиз', shape: 'terminal' },
  { id: 'bug', title: 'Новый баг' }, { id: 'fix', title: 'Исправление' }, { id: 'alone', title: 'Отдельный блок' },
], edges: [{ from: 'works', to: 'release', label: 'Да' }, { from: 'works', to: 'fix', label: 'Нет' },
  { from: 'release', to: 'bug' }, { from: 'bug', to: 'fix' }, { from: 'fix', to: 'works' }, { from: 'bug', to: 'bug', label: 'Повтор' }] }));
const flowLayout = await layoutDiagram(flow); check(flowLayout);
assert.equal(flowLayout.edges.length, flow.edges.length);
assert.equal((await layoutDiagram(malicious)).nodes[0].id, '__proto__');
assert.ok(wrapDiagramText('非常に長い文字列'.repeat(8)).every(line => [...line].length <= 12));
const maximum = parseMessageDiagram(JSON.stringify({ nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `Block ${i}` })),
  edges: [...Array.from({ length: 39 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })), ...Array.from({ length: 40 }, (_, i) => ({ from: `n${i}`, to: `n${(i + 7) % 40}` })), { from: 'n0', to: 'n0' }] }));
check(await layoutDiagram(maximum));
console.log('diagrams: strict schema, code protection, Telegram fallback, architecture, flowchart, cycles, self-loops, disconnected nodes and layout bounds passed');
