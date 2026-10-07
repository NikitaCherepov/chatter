import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import * as api from './api';
import type { MemoryRecord } from '../components/MemoryRecordsPanel';
import type { MapVector, MapPoint } from './memory-projection';
export type MemoryPage = { records: MemoryRecord[]; total: number; nextOffset: number | null; vectors?: MapVector[] };
export function memoryPageUrl(endpoint: string, params: Record<string, string | number>) {
  const url = new URL(endpoint, 'http://memory.local');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url.pathname + url.search;
}
export function useMemoryKey(endpoint = '') {
  const { user } = useAuth();
  return ['memory', api.API_BASE, user?.id ?? null, endpoint] as const;
}
export function useInvalidateMemory() {
  const client = useQueryClient();
  const key = useMemoryKey();
  return () => client.invalidateQueries({ queryKey: key.slice(0, 3) });
}
export function computeMemoryProjection(vectors: MapVector[], signal: AbortSignal): Promise<{ points: MapPoint[]; spaces: number }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./memory-projection.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { stop(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { stop(); event.data.result ? resolve(event.data.result) : reject(new Error('projection_failed')); };
    worker.onerror = () => { stop(); reject(new Error('projection_failed')); };
    worker.postMessage(vectors);
  });
}
