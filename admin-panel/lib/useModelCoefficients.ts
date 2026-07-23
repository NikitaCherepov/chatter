'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import type { ModelOverrideData } from './types';

type OverridesMap = Record<string, ModelOverrideData>;
type CoefficientsMap = Record<string, number>;

/**
 * Shared hook for editing model coefficients + provider/billing overrides
 * stored in `model_overrides`.
 *
 * - Loads coefficients AND overrides maps ONCE on first mount.
 * - Tracks "dirty" uniqueIds locally so a late-fetched server value cannot
 *   overwrite an unsaved user edit.
 * - Persists each coefficient via PUT on blur (caller decides when to call
 *   `saveCoefficient`).
 * - New: `saveOverride` for provider info, `getOverride` to read provider fields.
 *
 * Used by ManualModelListEditor (manual models) and ModelListEditor
 * (PRO / LITE / VISION fallback chains).
 */
export function useModelCoefficients() {
  const { t } = useTranslation();
  const [map, setMap] = useState<CoefficientsMap>({});
  const [overrides, setOverrides] = useState<OverridesMap>({});
  const [state, setState] = useState('');
  const loadedOnceRef = useRef(false);
  const dirtyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loadedOnceRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api<{ coefficients: CoefficientsMap; overrides?: OverridesMap }>('/api/model-coefficients');
        if (cancelled) return;
        loadedOnceRef.current = true;
        // Preserve locally-dirtied keys (do not let server overwrite unsaved edits).
        setMap(prev => {
          const next = { ...response.coefficients };
          for (const id of dirtyRef.current) {
            if (id in prev) next[id] = prev[id];
          }
          return next;
        });
        if (response.overrides) setOverrides(response.overrides);
        setState('');
      } catch (err) {
        setState(`${t('common.coefficientLoadError')}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveCoefficient = useCallback(async (uniqueId: string, coefficient: number) => {
    if (!uniqueId) return;
    dirtyRef.current.add(uniqueId);
    setMap(prev => ({ ...prev, [uniqueId]: coefficient }));
    try {
      await api(`/api/model-coefficients/${encodeURIComponent(uniqueId)}`, {
        method: 'PUT',
        body: JSON.stringify({ coefficient }),
      });
      setState(t('common.coefficientSaved'));
    } catch (err) {
      setState(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const setCoefficient = useCallback((uniqueId: string, coefficient: number) => {
    if (!uniqueId) return;
    dirtyRef.current.add(uniqueId);
    setMap(prev => ({ ...prev, [uniqueId]: coefficient }));
  }, []);

  const getCoefficient = useCallback((uniqueId: string | undefined | null): number | undefined => {
    if (!uniqueId) return undefined;
    const value = map[uniqueId];
    return typeof value === 'number' ? value : undefined;
  }, [map]);

  const getOverride = useCallback((uniqueId: string | undefined | null): ModelOverrideData | undefined => {
    if (!uniqueId) return undefined;
    return overrides[uniqueId];
  }, [overrides]);

  const saveOverride = useCallback(async (uniqueId: string, data: Partial<ModelOverrideData>) => {
    if (!uniqueId) return;
    dirtyRef.current.add(uniqueId);
    try {
      await api(`/api/models/${encodeURIComponent(uniqueId)}/billing`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      // Refresh local state
      setOverrides(prev => ({ ...prev, [uniqueId]: { ...prev[uniqueId], ...data } }));
      setState(t('common.coefficientSaved'));
    } catch (err) {
      setState(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  return { map, getCoefficient, setCoefficient, saveCoefficient, getOverride, saveOverride, state };
}
