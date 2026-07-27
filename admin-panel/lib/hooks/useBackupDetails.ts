'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { backupService } from '../services/backupService';

export function useBackupDetails(names: string[]) {
  const queries = useQueries({
    queries: names.map((name) => ({
      queryKey: ['backups', 'details', name],
      queryFn: () => backupService.getDetails(name),
      staleTime: 5 * 60_000,
      enabled: names.length > 0,
    })),
  });

  const map = useMemo(() => {
    const result = new Map<string, typeof queries[number]['data']>();
    for (let i = 0; i < names.length; i++) {
      if (queries[i]?.data) result.set(names[i], queries[i].data);
    }
    return result;
  }, [names, queries]);

  return { map };
}
