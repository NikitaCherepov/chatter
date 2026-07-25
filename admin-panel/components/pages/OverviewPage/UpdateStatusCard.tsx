'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useServerUpdate } from '../../../lib/hooks/useServerUpdate';
import { serverUpdateService, UPDATE_DRAIN_TIMEOUT_MS, UPDATE_POLL_INTERVAL_MS, type UpdateState } from '../../../lib/services/serverUpdateService';
import { ServerUpdateModal, type DrainState } from '../SystemPage/ServerUpdateModal/ServerUpdateModal';
import styles from './OverviewPage.module.css';

type DrainPhase = 'none' | 'draining' | 'updating';

export function UpdateStatusCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: info, isLoading: checking } = useServerUpdate();
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [message, setMessage] = useState('');

  // Drain state. `drain` holds the latest snapshot shown in the modal
  // (activeUsers + elapsed time). Initial fetch happens when the modal opens.
  const [drainPhase, setDrainPhase] = useState<DrainPhase>('none');
  const [drain, setDrain] = useState<DrainState | null>(null);
  const drainPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollErrorsRef = useRef(0);

  const activeStatuses = useMemo(() => new Set(['queued', 'backup', 'restarting']), []);
  const operationMatchesLatest = Boolean(
    info?.operation.targetHash
      && info.operation.targetHash === info.latestHash,
  );
  const updating = Boolean(
    info
      && operationMatchesLatest
      && activeStatuses.has(info.operation.status),
  );
  const operationStatus = !info || !operationMatchesLatest
    ? 'idle'
    : info.operation.status === 'complete' && info.available
      ? 'idle'
      : info.operation.status;
  const busy = checking || refreshing;
  const updateInProgress = updating || applying || drainPhase !== 'none';

  const clearDrainTimer = useCallback(() => {
    if (drainPollRef.current) {
      clearInterval(drainPollRef.current);
      drainPollRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => clearDrainTimer, [clearDrainTimer]);

  // Safety net: if the modal gets closed while a drain is still active,
  // stop the poll timer and ask the server to clear the drain flag so new
  // requests are unblocked. `updating` is excluded because apply() owns
  // that lifecycle.
  useEffect(() => {
    if (confirming || drainPhase === 'none' || drainPhase === 'updating') return;
    clearDrainTimer();
    setDrainPhase('none');
    setDrain(null);
    serverUpdateService.cancelUpdate().catch(() => { /* best-effort */ });
  }, [confirming, drainPhase, clearDrainTimer]);

  function updateDrainState(state: UpdateState) {
    setDrain({
      activeUsers: state.activeUsers,
      elapsedMs: state.elapsedMs,
      timeoutMs: UPDATE_DRAIN_TIMEOUT_MS,
    });
  }

  async function check() {
    setRefreshing(true);
    setMessage(t('system.update.fetchingInfo'));
    try {
      const fresh = await serverUpdateService.forceRefresh();
      queryClient.setQueryData(['server-update'], fresh);
      setMessage(fresh?.available ? t('system.update.found') : t('system.update.alreadyFresh'));
    } catch (err) {
      setMessage(t('system.update.checkError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRefreshing(false);
    }
  }

  async function applyUpdate() {
    setApplying(true);
    setApplyError('');
    setDrainPhase('updating');
    setMessage(t('system.update.starting'));
    try {
      await serverUpdateService.apply();
      queryClient.setQueryData(['server-update'], (current: typeof info) => current ? {
        ...current,
        operation: {
          status: 'queued' as const,
          targetHash: current.latestHash,
          message: 'server_update_queued',
          updatedAt: new Date().toISOString(),
        },
      } : current);
      await queryClient.invalidateQueries({ queryKey: ['server-update'] });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setApplyError(error);
      setMessage(t('system.update.updateError', { message: error }));
    } finally {
      setApplying(false);
    }
  }

  // Polls server drain state every UPDATE_POLL_INTERVAL_MS. Auto-applies when
  // activeUsers reaches 0. After UPDATE_DRAIN_TIMEOUT_MS we keep waiting but
  // the modal continues to show the count — the admin can still Force or Cancel.
  function startDrainPolling() {
    pollErrorsRef.current = 0;
    setDrainPhase('draining');

    drainPollRef.current = setInterval(async () => {
      try {
        const pollState = await serverUpdateService.getUpdateState();
        pollErrorsRef.current = 0;
        updateDrainState(pollState);

        if (pollState.activeUsers === 0) {
          clearDrainTimer();
          await applyUpdate();
        }
      } catch (err) {
        // After 3 consecutive poll failures, abort drain and surface the error.
        pollErrorsRef.current += 1;
        const msg = err instanceof Error ? err.message : String(err);
        setApplyError(t('system.update.drain.pollError', { message: msg }));
        if (pollErrorsRef.current >= 3) {
          clearDrainTimer();
          setDrainPhase('none');
          setDrain(null);
        }
      }
    }, UPDATE_POLL_INTERVAL_MS);
  }

  async function handleOpenModal() {
    setApplyError('');
    setConfirming(true);
    // Prefetch current activeUsers count without setting the drain flag.
    // The admin sees who is active before deciding soft / force / cancel.
    setDrain({ activeUsers: 0, elapsedMs: 0, timeoutMs: UPDATE_DRAIN_TIMEOUT_MS });
    try {
      const state = await serverUpdateService.getUpdateState();
      updateDrainState(state);
    } catch {
      // Non-fatal — the modal still opens, just without a precise count.
    }
  }

  // "Soft update": set drain flag (this also aborts active generations on the
  // server), then poll up to UPDATE_DRAIN_TIMEOUT_MS for remaining (HITL)
  // users to finish, then apply.
  async function handleSoftUpdate() {
    if (drainPhase !== 'none') return;
    try {
      const state = await serverUpdateService.prepareUpdate();
      updateDrainState(state);
      if (state.activeUsers === 0) {
        await applyUpdate();
        return;
      }
      startDrainPolling();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    }
  }

  // /fix
  // "Force now": set drain flag (so new requests are blocked during apply
  // window), abort everything immediately, then apply.
  async function handleForceUpdate() {
    clearDrainTimer();
    try {
      // Set the flag first so the window between "user clicked" and "apply
      // landed" is also covered. prepareUpdate also aborts active generations
      // as part of setUpdatePrepare() on the backend.
      await serverUpdateService.prepareUpdate();
      await serverUpdateService.forceUpdate();
      await applyUpdate();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleCancel() {
    setConfirming(false);
  }

  if (checking && !info) {
    return <strong className={styles.updateChecking}>{t('overview.updateStatus.checking')}</strong>;
  }

  if (!info?.supported) {
    return (
      <div className={styles.updateMini}>
        <span className={`${styles.updateDot} ${styles.updateOff}`} />
        <strong>{t('overview.updateStatus.unavailable')}</strong>
      </div>
    );
  }

  return (
    <>
      <div className={styles.updateMini}>
        <div className={styles.updateMiniInfo}>
          <span className={`${styles.updateDot} ${info.available ? styles.updateWarn : styles.updateOk}`} />
          <strong>{info.available
            ? t('overview.updateStatus.updateAvailable')
            : t('overview.updateStatus.upToDate')}</strong>
        </div>
        {message && <small className={styles.updateMsg}>{message}</small>}
        <div className={styles.updateActions}>
          <button type="button" className="buttonSecondary" disabled={busy || updateInProgress} onClick={() => void check()}>
            {t('system.update.check')}
          </button>
          {info.available && (
            <button type="button" disabled={busy || updateInProgress} onClick={() => void handleOpenModal()}>
              {updateInProgress ? t('system.update.updating') : t('system.update.updateButton')}
            </button>
          )}
        </div>
      </div>
      {confirming && info && (
        <ServerUpdateModal
          changelog={info.changelog}
          rebuiltFromSameCommit={false}
          updating={updateInProgress}
          operationStatus={applyError ? 'failed' : operationStatus}
          operationMessage={applyError || info.operation.message}
          drainPhase={drainPhase}
          drain={drain}
          onCancel={handleCancel}
          onSoftUpdate={handleSoftUpdate}
          onForceUpdate={handleForceUpdate}
        />
      )}
    </>
  );
}
