import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
import { Color } from 'three';
import { useTranslation } from 'react-i18next';
import * as api from '../lib/api';
import type { MapPoint, MapVector } from '../lib/memory-projection';
import { MemoryRecordCard, type MemoryRecord } from './MemoryRecordsPanel';
import s from './MemoryRecordsPanel.module.scss';

type Projection = { points: MapPoint[]; spaces: number };
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

export default function MemoryMap({ active, endpoint, records, matches, compact, onEdit, onDelete }: {
  active: boolean; endpoint: string; records: MemoryRecord[]; matches: Set<string> | null;
  compact: boolean; onEdit: (record: MemoryRecord) => void; onDelete: (record: MemoryRecord) => void;
}) {
  const { t } = useTranslation();
  const [projection, setProjection] = useState<Projection | null>(null);
  const [projectionKey, setProjectionKey] = useState('');
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [cameraVersion, setCameraVersion] = useState(0);
  const cache = useRef(new Map<string, Projection>());
  const signature = JSON.stringify(records.map(record => [record.id, record.updated_at, record.text]));
  const scope = `${api.API_BASE}:${endpoint}`;
  const key = `${scope}:${signature}`;
  useEffect(() => { setSelected(null); setCameraVersion(value => value + 1); }, [scope]);
  useEffect(() => {
    if (!active) return;
    setProjectionKey(key);
    const cached = cache.current.get(key);
    if (cached) { setProjection(cached); setFailed(false); return; }
    setProjection(null); setFailed(false);
    if (!records.length) { setProjection({ points: [], spaces: 0 }); return; }
    const controller = new AbortController();
    let cancelled = false, worker: Worker | undefined;
    void api.apiFetch<{ vectors?: MapVector[] }>(endpoint, { signal: controller.signal }).then(response => {
      if (cancelled) return;
      worker = new Worker(new URL('../lib/memory-projection.worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = () => { if (!cancelled) setFailed(true); worker?.terminate(); };
      worker.onmessage = (event: MessageEvent<{ result?: Projection; error?: string }>) => {
        worker?.terminate();
        if (cancelled) return;
        if (!event.data.result) { setFailed(true); return; }
        cache.current.set(key, event.data.result);
        if (cache.current.size > 3) cache.current.delete(cache.current.keys().next().value!);
        setProjection(event.data.result);
      };
      const allowed = new Set(records.map(record => record.id));
      worker.postMessage((response.vectors || []).filter(vector => allowed.has(vector.record_id)));
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; controller.abort(); worker?.terminate(); };
  }, [active, key, retry]);
  const selectedRecord = records.find(record => record.id === selected);
  if (!active) return null;
  if (failed && projectionKey === key) return <div className={s.empty}>{t('memoryMap.failed')} <button className={s.searchButton} onClick={() => setRetry(value => value + 1)}>{t('memoryMap.retry')}</button></div>;
  if (!projection || projectionKey !== key) return <div className={s.empty}>{t('memoryMap.loading')}</div>;
  const count = projection.points.length;
  return <div className={s.mapPanel}>
    <div className={s.mapToolbar}>
      <span>{t('memoryMap.count', { shown: count, total: records.length })}</span>
      {matches !== null && <span>{t('memoryMap.found', { count: matches.size })}</span>}
      <button type="button" className={s.searchButton} onClick={() => { cache.current.delete(key); setRetry(value => value + 1); }}>{t('memoryMap.refresh')}</button>
      <button type="button" className={s.searchButton} onClick={() => setCameraVersion(value => value + 1)}>{t('memoryMap.reset')}</button>
    </div>
    {count ? <div className={`${s.mapCanvas} ${compact ? s.compactMap : ''}`}>
      <MapBoundary fallback={<div className={s.empty}>{t('memoryMap.webgl')}</div>}>
        <Canvas key={`${scope}:${cameraVersion}`} frameloop="demand" dpr={[1, 2]} camera={{ position: [0, 0, Math.max(10, projection.spaces * 9)], fov: 45 }}
          fallback={<div className={s.empty}>{t('memoryMap.webgl')}</div>}>
          <Cloud points={projection.points} records={records} matches={matches} selected={selected} onSelect={setSelected} />
          <OrbitControls makeDefault enableDamping minDistance={1} maxDistance={Math.max(40, projection.spaces * 30)} />
        </Canvas>
      </MapBoundary>
    </div> : <div className={s.empty}>{t('memoryMap.noVectors')}</div>}
    <div className={s.mapHint}>{t('memoryMap.help')}{projection.spaces > 1 && <> {t('memoryMap.separateSpaces')}</>}</div>
    {selectedRecord && <MemoryRecordCard record={selectedRecord} compact={false} onEdit={onEdit} onDelete={onDelete} />}
  </div>;
}
