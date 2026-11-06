import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compileMcpInputSchema } = require('../src/services/mcp/input-schema.ts');
for (const dialect of [
  undefined,
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
]) {
  const schema = {
    ...(dialect ? { $schema: dialect } : {}),
    type: 'object',
    properties: { action: { type: 'string', enum: ['list', 'new'] } },
    required: ['action'],
    additionalProperties: false,
  };
  const before = JSON.stringify(schema),
    validate = compileMcpInputSchema(schema);
  assert.equal(validate({ action: 'list' }), true);
  assert.equal(validate({ action: 'wrong' }), false);
  assert.equal(validate({ action: 'list', extra: true }), false);
  assert.equal(JSON.stringify(schema), before, 'input schemas are not modified');
}
const modern = compileMcpInputSchema({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    point: {
      type: 'array',
      prefixItems: [{ type: 'number' }, { type: 'number' }],
      items: false,
      minItems: 2,
    },
  },
  required: ['point'],
  unevaluatedProperties: false,
});
assert.equal(modern({ point: [1, 2] }), true);
assert.equal(modern({ point: ['x', 2] }), false, '2020 tuple types enforced');
assert.equal(modern({ point: [1, 2, 3] }), false, '2020 tuple length enforced');
assert.equal(modern({ point: [1, 2], extra: true }), false, 'unevaluatedProperties enforced');
const legacy = compileMcpInputSchema({
  type: 'array',
  items: [{ type: 'number' }],
  additionalItems: false,
});
assert.equal(legacy([1]), true);
assert.equal(legacy([1, 2]), false, 'legacy tuple semantics retained');
const previous = compileMcpInputSchema({
  $schema: 'https://json-schema.org/draft/2019-09/schema',
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  dependentRequired: { a: ['b'] },
});
assert.equal(previous({ a: 1, b: 2 }), true);
assert.equal(previous({ a: 1 }), false);
assert.throws(
  () => compileMcpInputSchema({ $schema: 'https://other.example/schema', type: 'object' }),
  /mcp_unsupported_schema_dialect/,
);
assert.throws(
  () => compileMcpInputSchema({ $schema: 7, type: 'object' }),
  /mcp_invalid_tool_schema/,
);
assert.throws(
  () => compileMcpInputSchema({ type: 'object', properties: { x: { type: 'not-a-type' } } }),
  /mcp_invalid_tool_schema/,
);
assert.throws(
  () =>
    compileMcpInputSchema({
      type: 'object',
      properties: { x: { $ref: 'https://private.example/schema' } },
    }),
  /mcp_invalid_tool_schema/,
);
console.log(
  'PASS: MCP schema Draft-07/2019-09/2020-12, modern tuple semantics, strict argument validation and explicit schema errors',
);
