export type MapVector = { record_id: string; values: number[]; embedding_model: string };
export type MapPoint = { id: string; position: [number, number, number] };

/** Deterministic centered PCA, computed without a d-by-d covariance matrix. */
export function projectMemory(vectors: MapVector[]): { points: MapPoint[]; spaces: number } {
  const groups = new Map<string, MapVector[]>();
  for (const vector of [...vectors].sort((a, b) => a.record_id.localeCompare(b.record_id))) {
    if (!vector.values.length || vector.values.some(value => !Number.isFinite(value))) continue;
    const key = `${vector.embedding_model}:${vector.values.length}`;
    const group = groups.get(key) || [];
    group.push(vector); groups.set(key, group);
  }
  const points: MapPoint[] = [];
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([, group], groupIndex) => {
    const dimension = group[0].values.length;
    const mean = new Float64Array(dimension);
    group.forEach(vector => vector.values.forEach((value, index) => { mean[index] += value / group.length; }));
    const rows = group.map(vector => Float64Array.from(vector.values, (value, index) => value - mean[index]));
    const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
    const basis: Float64Array[] = [];
    for (let axis = 0; axis < Math.min(3, dimension, group.length - 1); axis++) {
      let direction = Float64Array.from({ length: dimension }, (_, i) => Math.sin((i + 1) * (axis + 1) * 1.618));
      for (let step = 0; step < 32; step++) {
        const next = new Float64Array(dimension);
        rows.forEach(row => { const weight = dot(row, direction); row.forEach((value, i) => { next[i] += value * weight; }); });
        basis.forEach(previous => { const weight = dot(next, previous); next.forEach((_, i) => { next[i] -= weight * previous[i]; }); });
        const norm = Math.sqrt(dot(next, next));
        if (norm < 1e-12) { direction = new Float64Array(dimension); break; }
        direction = next.map(value => value / norm);
      }
      // Resolve the arbitrary PCA sign so input reordering does not flip the map.
      const pivot = direction.reduce((best, value, i) => Math.abs(value) > Math.abs(direction[best]) ? i : best, 0);
      if (direction[pivot] < 0) direction = direction.map(value => -value);
      basis.push(direction);
    }
    const positions = rows.map(row => [0, 1, 2].map(axis => basis[axis] ? dot(row, basis[axis]) : 0));
    const radius = Math.max(...positions.map(position => Math.hypot(...position)), 1e-9);
    group.forEach((vector, index) => points.push({ id: vector.record_id, position: [
      positions[index][0] * 3 / radius + (groupIndex - (groups.size - 1) / 2) * 8,
      positions[index][1] * 3 / radius,
      positions[index][2] * 3 / radius,
    ] }));
  });
  return { points, spaces: groups.size };
}
