import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-subagent-catalog-${process.pid}-${Date.now()}.sqlite`);
const { listSubagentCatalog, listSubagentNames } = await import('../src/services/subagents/registry.js');
const catalog = listSubagentCatalog();
assert.deepEqual(catalog.map(agent => agent.id), listSubagentNames());
assert(catalog.length > 0);
for (const agent of catalog) {
  assert.deepEqual(Object.keys(agent).sort(), ['description', 'id']);
  assert.equal(typeof agent.description, 'string');
  assert(agent.description.length > 0);
}
const original = catalog[0].description;
catalog[0].description = 'changed client-side';
assert.equal(listSubagentCatalog()[0].description, original);
console.log('Subagent catalog exposes registry IDs and descriptions only; returned metadata is detached.');
