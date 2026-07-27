import { useQuery } from '@tanstack/react-query';
import { backupService } from '../services/backupService';

export function useBackups() {
  return useQuery({
    queryKey: ['backups'],
    queryFn: () => backupService.getBackups(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useBackupSchedule() {
  return useQuery({
    queryKey: ['backups', 'schedule'],
    queryFn: () => backupService.getSchedule(),
  });
}
