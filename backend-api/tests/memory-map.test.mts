import assert from 'node:assert/strict';
const { averageMemoryVectors } = await import('../src/services/memory-map-vectors.js');
const { projectMemory } = await import('../../desktop-app/src/renderer/lib/memory-projection.js');

const vectors = averageMemoryVectors([
  { record_id: 'a', values: [2, 0, 0], embedding_model: 'm' },
  { record_id: 'a', values: [0, 4, 0], embedding_model: 'm' },
  { record_id: 'b', values: [0, 0, 1], embedding_model: 'm' },
  { record_id: 'a', values: [1, 0], embedding_model: 'other' },
  { record_id: 'invalid', values: [NaN], embedding_model: 'm' },
  { record_id: 'zero', values: [0, 0, 0], embedding_model: 'm' },
]);
assert.equal(vectors.length, 2);
assert.equal(vectors[0].embedding_model, 'm', 'do not mix models or dimensions when averaging');
assert(Math.abs(vectors[0].values[0] - Math.SQRT1_2) < 1e-9);
assert(Math.abs(vectors[0].values[1] - Math.SQRT1_2) < 1e-9);
assert.deepEqual(projectMemory([]), { points: [], spaces: 0 });
assert.deepEqual(projectMemory([vectors[0]]).points[0].position, [0, 0, 0]);
const points = projectMemory(vectors);
assert.deepEqual(points, projectMemory([...vectors].reverse()), 'input ordering does not flip the map');
assert(points.points.every(point => point.position.every(Number.isFinite)));
assert.notDeepEqual(points.points[0].position, points.points[1].position);
const separate = projectMemory([...vectors, { record_id: 'c', values: [1, 0], embedding_model: 'other' }]);
assert.equal(separate.spaces, 2, 'incompatible embedding spaces are separate clouds');
assert.equal(projectMemory([vectors[0], { ...vectors[0], record_id: 'copy' }]).points.length, 2, 'identical vectors are retained');
console.log('memory vector averaging and deterministic PCA tests passed');
