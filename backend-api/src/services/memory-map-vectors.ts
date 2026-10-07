export type MemoryMapVector = { record_id: string; values: number[]; embedding_model: string };

/** A single normalized representative per record; never mix embedding spaces. */
export function averageMemoryVectors(chunks: Array<{ record_id: string; values: number[]; embedding_model: string }>): MemoryMapVector[] {
  const records = new Map<string, Map<string, { sum: number[]; count: number; model: string }>>();
  for (const chunk of chunks) {
    if (!chunk.values.length || chunk.values.some(value => !Number.isFinite(value))) continue;
    const norm = Math.hypot(...chunk.values);
    if (!norm) continue;
    const spaces = records.get(chunk.record_id) ?? new Map();
    const key = `${chunk.embedding_model}:${chunk.values.length}`;
    const group = spaces.get(key) ?? { sum: Array(chunk.values.length).fill(0), count: 0, model: chunk.embedding_model };
    chunk.values.forEach((value, index) => { group.sum[index] += value / norm; });
    group.count++;
    spaces.set(key, group);
    records.set(chunk.record_id, spaces);
  }
  return [...records].flatMap(([record_id, spaces]) => {
    const group = [...spaces.values()].sort((a, b) => b.count - a.count)[0];
    const norm = Math.hypot(...group.sum);
    return norm ? [{ record_id, values: group.sum.map(value => value / norm), embedding_model: group.model }] : [];
  });
}
