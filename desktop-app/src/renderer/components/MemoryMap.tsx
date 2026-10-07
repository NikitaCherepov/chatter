import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
import { Color } from 'three';
import { useTranslation } from 'react-i18next';
import * as api from '../lib/api';
import type { MapPoint, MapVector } from '../lib/memory-projection';
import { MemoryRecordCard, type MemoryRecord } from './MemoryRecordsPanel';
import s from './MemoryRecordsPanel.module.scss';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { computeMemoryProjection, memoryPageUrl, useMemoryKey, type MemoryPage } from '../lib/memory-queries';
import { Select } from './Select';
import { ConfirmDialog } from './ConfirmDialog';
class MapBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Cloud({ points, records, matches, selected, onSelect }: {
  points: MapPoint[]; records: MemoryRecord[]; matches: Set<string> | null;
  selected: string | null; onSelect: (id: string) => void;
}) {
  const { raycaster } = useThree();
  useEffect(() => { raycaster.params.Points = { threshold: 0.14 }; }, [raycaster]);
  const positions = useMemo(() => Float32Array.from(points.flatMap(point => point.position)), [points]);
  const { colors, sizes } = useMemo(() => {
    const byId = new Map(records.map(record => [record.id, record]));
    const colors: number[] = [], sizes: number[] = [];
    for (const point of points) {
      const source = byId.get(point.id)?.source || 'memory';
      let hash = 0; for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      const matched = matches === null || matches.has(point.id);
      const color = point.id === selected ? new Color('#ffffff') : new Color().setHSL((hash % 360) / 360, 0.65, 0.65);
      if (!matched && point.id !== selected) color.multiplyScalar(0.18);
      colors.push(color.r, color.g, color.b);
      sizes.push(point.id === selected ? 17 : matched ? 10 : 5);
    }
    return { colors: Float32Array.from(colors), sizes: Float32Array.from(sizes) };
  }, [points, records, matches, selected]);
  return <points onClick={(event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation(); if (event.index !== undefined && points[event.index]) onSelect(points[event.index].id);
  }}>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      <bufferAttribute attach="attributes-pointSize" args={[sizes, 1]} />
    </bufferGeometry>
    <shaderMaterial transparent depthWrite={false} vertexColors
      vertexShader={'attribute float pointSize; varying vec3 pointColor; void main(){pointColor=color; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize=pointSize;}'}
      fragmentShader={'varying vec3 pointColor; void main(){float r=length(gl_PointCoord-vec2(0.5)); if(r>0.5) discard; gl_FragColor=vec4(pointColor,1.0-smoothstep(0.30,0.5,r));}'} />
  </points>;
}

export default function MemoryMap({ active, endpoint, matches, textQuery, compact, onEdit, onDelete }: {
  active: boolean; endpoint: string; matches: Set<string> | null; textQuery: string;
  compact: boolean; onEdit: (record: MemoryRecord) => void; onDelete: (record: MemoryRecord) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = useMemoryKey(endpoint);
  const [limit, setLimit] = useState('1000');
  const [generated, setGenerated] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [cameraVersion, setCameraVersion] = useState(0);
  const countQuery = useQuery({
    queryKey: [...key, 'count'],
    queryFn: ({ signal }) => api.apiFetch<MemoryPage>(memoryPageUrl(endpoint, { limit: 1, offset: 0 }), { signal }),
    enabled: active, staleTime: 60_000, gcTime: 300_000,
  });
  const vectorKey = [...key, 'vectors', generated];
  const vectorsQuery = useQuery({
    queryKey: vectorKey,
    queryFn: async ({ signal }) => {
      const records = new Map<string, MemoryRecord>(), vectors = new Map<string, MapVector>();
      let offset = 0, total = 0;
      while (offset < generated) {
        signal.throwIfAborted();
        const page = await api.apiFetch<MemoryPage>(memoryPageUrl(endpoint, { limit: Math.min(500, generated - offset), offset, include_vectors: 1 }), { signal });
        total = page.total;
        page.records.forEach(record => records.set(record.id, record));
        (page.vectors ?? []).forEach(vector => vectors.set(vector.record_id, vector));
        if (page.nextOffset === null || !page.records.length) break;
        if (page.nextOffset <= offset) throw new Error('invalid_memory_page');
        offset = page.nextOffset;
      }
      return { records: [...records.values()], vectors: [...vectors.values()], total };
    },
    enabled: active && generated > 0,
    staleTime: 300_000, gcTime: 300_000, retry: false,
  });
  const projectionQuery = useQuery({
    queryKey: [...key, 'projection', generated, vectorsQuery.dataUpdatedAt],
    queryFn: ({ signal }) => computeMemoryProjection(vectorsQuery.data?.vectors ?? [], signal),
    enabled: active && generated > 0 && Boolean(vectorsQuery.data) && !vectorsQuery.isFetching,
    staleTime: Infinity, gcTime: 300_000, retry: false,
  });
  const records = vectorsQuery.data?.records ?? [];
  const projection = projectionQuery.data;
  const effectiveMatches = useMemo(() => textQuery
    ? new Set(records.filter(record => (record.source + '\\n' + record.text).toLocaleLowerCase().includes(textQuery.toLocaleLowerCase())).map(record => record.id))
    : matches, [records, textQuery, matches]);
  const selectedRecord = records.find(record => record.id === selected);
  const building = generated > 0 && (vectorsQuery.isFetching || projectionQuery.isFetching || (!projection && !vectorsQuery.isError && !projectionQuery.isError));
  const cancel = () => {
    void client.cancelQueries({ queryKey: vectorKey });
    void client.cancelQueries({ queryKey: [...key, 'projection'] });
    setGenerated(0);
  };
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: [...key, 'count'] });
    await client.invalidateQueries({ queryKey: vectorKey });
  };
  if (!active) return null;
  return <div className={s.mapPanel}>
    <div className={s.mapToolbar}>
      <span>{t('memoryMap.total', { count: countQuery.data?.total ?? 0 })}</span>
      <div className={s.mapLimit}>
        <Select value={limit} onChange={setLimit} options={[100, 500, 1000, 2000, 5000].map(value => ({ value: String(value), label: t('memoryMap.limit', { count: value }) }))} />
      </div>
      <button type="button" className={s.searchButton} disabled={countQuery.isPending || countQuery.isError || !countQuery.data?.total || building} onClick={() => setConfirm(true)}>{t('memoryMap.build')}</button>
    </div>
    <div className={s.mapHint}>{t('memoryMap.warning', { count: Math.min(Number(limit), countQuery.data?.total ?? 0), total: countQuery.data?.total ?? 0 })}</div>
    <ConfirmDialog open={confirm} title={t('memoryMap.build')} text={t('memoryMap.warning', { count: Math.min(Number(limit), countQuery.data?.total ?? 0), total: countQuery.data?.total ?? 0 })} confirmLabel={t('memoryMap.build')} confirmTone="primary"
      onCancel={() => setConfirm(false)} onConfirm={() => { setGenerated(Number(limit)); setSelected(null); setConfirm(false); }} />
    {(countQuery.isError || vectorsQuery.isError || projectionQuery.isError) && <div className={s.empty}>{t('memoryMap.failed')} <button className={s.searchButton} onClick={() => { void countQuery.refetch(); if (generated) { void vectorsQuery.refetch(); void projectionQuery.refetch(); } }}>{t('memoryMap.retry')}</button></div>}
    {building && <div className={s.empty}>{t('memoryMap.loading')} <button className={s.searchButton} onClick={cancel}>{t('common.cancel')}</button></div>}
    {generated > 0 && projection && !building && !vectorsQuery.isError && !projectionQuery.isError && <>
      <div className={s.mapToolbar}>
        <span>{t('memoryMap.count', { shown: projection.points.length, total: vectorsQuery.data?.total ?? 0 })}</span>
        {effectiveMatches !== null && <span>{t('memoryMap.found', { count: effectiveMatches.size })}</span>}
        <button type="button" className={s.searchButton} onClick={() => void refresh()}>{t('memoryMap.refresh')}</button>
        <button type="button" className={s.searchButton} onClick={() => setCameraVersion(value => value + 1)}>{t('memoryMap.reset')}</button>
      </div>
      {projection.points.length ? <div className={`${s.mapCanvas} ${compact ? s.compactMap : ''}`}>
        <MapBoundary fallback={<div className={s.empty}>{t('memoryMap.webgl')}</div>}>
          <Canvas key={cameraVersion} frameloop="demand" dpr={[1, 2]} camera={{ position: [0, 0, Math.max(10, projection.spaces * 9)], fov: 45 }} fallback={<div className={s.empty}>{t('memoryMap.webgl')}</div>}>
            <Cloud points={projection.points} records={records} matches={effectiveMatches} selected={selected} onSelect={setSelected} />
            <OrbitControls makeDefault enableDamping minDistance={1} maxDistance={Math.max(40, projection.spaces * 30)} />
          </Canvas>
        </MapBoundary>
      </div> : <div className={s.empty}>{t('memoryMap.noVectors')}</div>}
      <div className={s.mapHint}>{t('memoryMap.help')}{projection.spaces > 1 && <> {t('memoryMap.separateSpaces')}</>}</div>
      {selectedRecord && <MemoryRecordCard record={selectedRecord} compact={false} onEdit={onEdit} onDelete={onDelete} />}
    </>}
  </div>;
}
