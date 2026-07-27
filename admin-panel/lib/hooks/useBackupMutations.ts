'use client';

import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { BackupInfo, BackupSchedule } from '../../components/pages/SystemPage/types';
import { backupService } from '../services/backupService';

function messageFromError(error: Error) {
  return error instanceof Error ? error.message : String(error);
}

export function useBackupMutations(t: TFunction) {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (opts: { includeUploads: boolean; includeConfiguration: boolean }) =>
      backupService.create(opts.includeUploads, opts.includeConfiguration),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backups'], exact: true });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => backupService.delete(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backups'], exact: true });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (name: string) => backupService.restore(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backups'], exact: true });
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: (schedule: BackupSchedule) => backupService.saveSchedule(schedule),
    onSuccess: (saved) => {
      queryClient.setQueryData(['backups', 'schedule'], saved);
    },
  });

  // ─── Derived UI state ────────────────────────────────────────────────────
  const message = useMemo(() => {
    if (createMutation.error) return t('system.error', { message: messageFromError(createMutation.error) });
    if (deleteMutation.error) return t('system.error', { message: messageFromError(deleteMutation.error) });
    if (restoreMutation.error) return t('system.restoreError', { message: messageFromError(restoreMutation.error) });
    if (createMutation.isPending) return t('system.backups.creatingDb');
    if (createMutation.isSuccess) return t('system.backups.created');
    if (deleteMutation.isPending) return t('system.backups.deleting');
    if (deleteMutation.isSuccess) return t('system.backups.deleted');
    if (restoreMutation.isPending) return t('system.backups.restoring');
    if (restoreMutation.isSuccess) return t('system.backups.restored');
    return '';
  }, [t, createMutation.isPending, createMutation.isSuccess, createMutation.error,
    deleteMutation.isPending, deleteMutation.isSuccess, deleteMutation.error,
    restoreMutation.isPending, restoreMutation.isSuccess, restoreMutation.error]);

  const scheduleMessage = useMemo(() => {
    if (scheduleMutation.error) return t('system.error', { message: messageFromError(scheduleMutation.error) });
    if (scheduleMutation.isPending) return t('system.schedule.saving');
    if (scheduleMutation.isSuccess) return t('system.schedule.saved');
    return '';
  }, [t, scheduleMutation.isPending, scheduleMutation.isSuccess, scheduleMutation.error]);

  return { createMutation, deleteMutation, restoreMutation, scheduleMutation, message, scheduleMessage };
}
