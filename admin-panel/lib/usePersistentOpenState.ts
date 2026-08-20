'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_PREFIX = 'chatter:open:';

function loadStoredIds(storageKey: string): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
  }
}

/**
 * Persists a set of "open" item ids (collapsed sections, expanded cards, …)
 * in localStorage so UI state survives page reloads.
 *
 * Until the user interacts at least once (`null`), callers fall back to their
 * own defaults via `isOpen(id, defaultOpen)`.
 */
export function usePersistentOpenState(storageKey: string) {
  const [openIds, setOpenIds] = useState<Set<string> | null>(() => loadStoredIds(storageKey));

  useEffect(() => {
    if (!openIds) return;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify([...openIds]));
    } catch {
      // Storage unavailable (private mode, quota) — state stays in memory only.
    }
  }, [storageKey, openIds]);

  const setOpen = useCallback((id: string, open: boolean) => {
    setOpenIds((current) => {
      const next = new Set(current ?? []);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const isOpen = useCallback(
    (id: string, defaultOpen = false) => (openIds === null ? defaultOpen : openIds.has(id)),
    [openIds],
  );

  return { isOpen, setOpen };
}
