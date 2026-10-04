import type { UpdateOperation } from './serverUpdateService';

export const activeUpdateStatuses = new Set<UpdateOperation['status']>(['queued', 'pulling', 'backup', 'restarting']);

export function visibleUpdateStatus(
  operation: UpdateOperation | undefined,
  watchedOperationId: string | null,
): UpdateOperation['status'] {
  // Opening confirmation must not display the previous attempt's terminal
  // result. Once POST accepts an attempt, keep its result even if the registry
  // tag changes or an image ID has a different representation in Docker.
  if (watchedOperationId === 'pending') return 'queued';
  if (!operation) return 'idle';
  if (watchedOperationId && operation.operationId === watchedOperationId) return operation.status;
  return activeUpdateStatuses.has(operation.status) ? operation.status : 'idle';
}
