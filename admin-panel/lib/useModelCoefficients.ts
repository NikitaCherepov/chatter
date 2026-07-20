'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';

/**
 * Shared hook for editing model coefficients stored in `model_overrides`.
 *
 * - Loads the whole coefficients map ONCE on first mount (lazy refresh only on
 *   explicit `reload()` call).
 * - Tracks "dirty" uniqueIds locally so a late-fetched server value cannot
 *   overwrite an unsaved user edit.
 * - Persists each coefficient via PUT on blur (caller decides when to call
 *   `saveCoefficient`).
 *
 * Used by ManualModelListEditor (manual models) and ModelListEditor
 * (PRO / LITE / VISION fallback chains).
 */
export function useModelCoefficients() {
  const { t } = useTranslation();
  const [map, setMap] = useState<Record<string, number>>({});
  const [state, setState] = useState('');
  const loadedOnceRef = useRef(false);
  const dirtyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loadedOnceRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api<{ coefficients: Record<string, number> }>('/api/model-coefficients');
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

  const getCoefficient = useCallback((uniqueId: string | undefined | null): number | undefined => {
    if (!uniqueId) return undefined;
    const value = map[uniqueId];
    return typeof value === 'number' ? value : undefined;
  }, [map]);

  return { map, getCoefficient, saveCoefficient, state };
}
