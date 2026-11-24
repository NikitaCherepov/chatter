import * as api from './api';
import { memoryPageUrl, type MemoryPage } from './memory-queries';
import type { MemoryRecord } from '../components/MemoryRecordsPanel';
import type { MapVector } from './memory-projection';
export type MemorySpace = { id: number; name: string; kind: 'general' | 'chat'; is_default: number; is_primary: number };
export const listMemorySpaces = (signal?: AbortSignal) => api.apiFetch<{ spaces: MemorySpace[] }>('/api/v1/memory/spaces', { signal });
export const createMemorySpace = (name: string) => api.apiFetch<{ space: MemorySpace }>('/api/v1/memory/spaces', { method: 'POST', body: JSON.stringify({ name }) });
export const activateMemorySpace = (id: number) => api.apiFetch<{ space: MemorySpace }>(`/api/v1/memory/spaces/${id}/activate`, { method: 'POST' });
export const renameMemorySpace = (id: number, name: string) => api.apiFetch<{ space: MemorySpace }>(`/api/v1/memory/spaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const deleteMemorySpace = (id: number) => api.apiFetch<{ active_space: MemorySpace }>(`/api/v1/memory/spaces/${id}`, { method: 'DELETE' });
export const updateMemoryRecord = (id: string, text: string, source?: string) => api.apiFetch<{ record: MemoryRecord }>(`/api/v1/memory/records/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ text, ...(source === undefined ? {} : { source }) }) });
export const deleteMemoryRecord = (id: string) => api.apiFetch(`/api/v1/memory/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const listGeneralMemoryRecords = (spaceId: number, query: string, limit: number, offset: number, signal: AbortSignal) => api.apiFetch<MemoryPage>(memoryPageUrl('/api/v1/memory/records', { space_id: spaceId, query, limit, offset }), { signal });
export const searchGeneralMemoryRecords = (spaceId: number, query: string, signal: AbortSignal) => api.apiFetch<{ records: MemoryRecord[]; groups?: { record_id: string }[] }>('/api/v1/memory/records/search', { method: 'POST', body: JSON.stringify({ space_id: spaceId, query }), signal });

/** Shared bounded loader for the native map and a theme's own visualization. */
export async function loadMemoryMapData(endpoint: string, limit: number, signal: AbortSignal) {
  const records = new Map<string, MemoryRecord>(), vectors = new Map<string, MapVector>();
  let offset = 0, total = 0;
  while (offset < limit) {
    signal.throwIfAborted();
    const page = await api.apiFetch<MemoryPage>(memoryPageUrl(endpoint, { limit: Math.min(500, limit - offset), offset, include_vectors: 1 }), { signal });
    total = page.total;
    page.records.forEach(record => records.set(record.id, record));
    (page.vectors ?? []).forEach(vector => vectors.set(vector.record_id, vector));
    if (page.nextOffset === null || !page.records.length) break;
    if (page.nextOffset <= offset) throw new Error('invalid_memory_page');
    offset = page.nextOffset;
  }
  return { records: [...records.values()], vectors: [...vectors.values()], total };
}
