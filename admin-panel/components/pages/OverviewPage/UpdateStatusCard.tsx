'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useServerUpdate } from '../../../lib/hooks/useServerUpdate';
import { serverUpdateService, UPDATE_DRAIN_TIMEOUT_MS, UPDATE_POLL_INTERVAL_MS, type UpdateState } from '../../../lib/services/serverUpdateService';
import { ServerUpdateModal, type DrainState } from '../SystemPage/ServerUpdateModal/ServerUpdateModal';
import styles from './OverviewPage.module.css';

// ─── State machine ───────────────────────────────────────────────────────────
//
// idle       — modal open, admin hasn't picked an action yet.
// draining   — prepareUpdate() called, flag is set, polling + 15s timer running.
//              Auto-applies when activeUsers hits 0 before timeout.
// timeout    — 15s elapsed, activeUsers > 0. Only Force / Cancel available.
// applying   — applyUpdate() in progress (server is updating).
//
type DrainPhase = 'idle' | 'draining' | 'timeout' | 'applying';

export function UpdateStatusCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: info, isLoading: checking } = useServerUpdate();
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [applyError, setApplyError] = useState('');

  const [drainPhase, setDrainPhase] = useState<DrainPhase>('idle');
  const [drain, setDrain] = useState<DrainState | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const drainStartRef = useRef<number>(0);
  const phaseRef = useRef<DrainPhase>('idle');

  // Keep phaseRef in sync so interval callbacks read the latest value.
  useEffect(() => { phaseRef.current = drainPhase; }, [drainPhase]);

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
  const updateInProgress = updating || drainPhase === 'applying';

  // ─── Timers cleanup ──────────────────────────────────────────────────────
  const clearAllTimers = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearAllTimers, [clearAllTimers]);

  // If modal closed while drain active — clear flag on backend, reset state.
  useEffect(() => {
    if (confirming) return;
    if (drainPhase === 'idle' || drainPhase === 'applying') return;
    clearAllTimers();
    setDrainPhase('idle');
    setDrain(null);
    serverUpdateService.cancelUpdate().catch(() => { /* best-effort */ });
  }, [confirming, drainPhase, clearAllTimers]);

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function syncDrainDisplay(activeUsers: number) {
    setDrain({
      activeUsers,
      elapsedMs: Date.now() - drainStartRef.current,
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
    setApplyError('');
    setDrainPhase('applying');
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
    }
  }

  // ─── 1. Soft ("Wait up to 15s and update") ───────────────────────────────
  // prepareUpdate() → poll activeUsers + run 15s timer.
  // If activeUsers === 0 before timeout → auto applyUpdate().
  // If timeout reached with activeUsers > 0 → state = 'timeout'.
  async function handleSoftUpdate() {
    if (drainPhase !== 'idle') return;
    drainStartRef.current = Date.now();
    setDrainPhase('draining');
    setDrain({ activeUsers: 0, elapsedMs: 0, timeoutMs: UPDATE_DRAIN_TIMEOUT_MS });

    // 1. Set flag (new requests blocked on backend).
    let initialState: UpdateState;
    try {
      initialState = await serverUpdateService.prepareUpdate();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
      setDrainPhase('idle');
      setDrain(null);
      return;
    }
    syncDrainDisplay(initialState.activeUsers);

    // Edge case: nobody active — apply immediately.
    if (initialState.activeUsers === 0) {
      clearAllTimers();
      await applyUpdate();
      return;
    }

    // 2. Poll activeUsers from server. Runs in both `draining` and `timeout`
    //    phases — the count must stay live even after the 15s deadline.
    //    If users drain to 0 in EITHER phase, auto-apply the update.
    pollTimerRef.current = setInterval(async () => {
      try {
        const pollState = await serverUpdateService.getUpdateState();
        syncDrainDisplay(pollState.activeUsers);
        if (pollState.activeUsers === 0 && (phaseRef.current === 'draining' || phaseRef.current === 'timeout')) {
          clearAllTimers();
          await applyUpdate();
        }
      } catch {
        // Transient network error — keep polling.
      }
    }, UPDATE_POLL_INTERVAL_MS);

    // 3. UI tick + 15s deadline. Stops only the tick timer when timeout
    //    is reached — polling continues until admin acts or users drain.
    tickTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - drainStartRef.current;
      setDrain((prev) => prev ? { ...prev, elapsedMs: elapsed } : prev);
      if (elapsed >= UPDATE_DRAIN_TIMEOUT_MS && phaseRef.current === 'draining') {
        if (tickTimerRef.current) {
          clearInterval(tickTimerRef.current);
          tickTimerRef.current = null;
        }
        setDrainPhase('timeout');
      }
    }, 200);
  }

  // ─── 2. Force ("Force update now") ───────────────────────────────────────
  // prepareUpdate() → forceAbortActiveGenerations() → applyUpdate().
  async function handleForceUpdate() {
    clearAllTimers();
    try {
      await serverUpdateService.prepareUpdate();
      await serverUpdateService.forceUpdate();
      await applyUpdate();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── 3. Cancel ───────────────────────────────────────────────────────────
  // Clear flag on backend, close modal.
  async function handleCancel() {
    clearAllTimers();
    if (drainPhase !== 'idle' && drainPhase !== 'applying') {
      try { await serverUpdateService.cancelUpdate(); } catch { /* best-effort */ }
    }
    setDrainPhase('idle');
    setDrain(null);
    setConfirming(false);
  }

  async function handleOpenModal() {
    setApplyError('');
    setConfirming(true);
    setDrainPhase('idle');
    setDrain({ activeUsers: 0, elapsedMs: 0, timeoutMs: UPDATE_DRAIN_TIMEOUT_MS });
    try {
      const state = await serverUpdateService.getUpdateState();
      // If the drain flag is already set on the backend (e.g. admin reloaded
      // the page mid-drain), resume polling instead of pretending nothing
      // happened. The flag blocks all user AI requests, so we must not
      // ignore it.
      if (state.preparing) {
        drainStartRef.current = Date.now() - state.elapsedMs;
        setDrainPhase('draining');
        syncDrainDisplay(state.activeUsers);
        // Edge case: flag stuck but nobody active — apply immediately.
        if (state.activeUsers === 0) {
          await applyUpdate();
          return;
        }
        // Resume polling + enforce remaining time budget.
        const remainingMs = Math.max(0, UPDATE_DRAIN_TIMEOUT_MS - state.elapsedMs);
        pollTimerRef.current = setInterval(async () => {
          try {
            const pollState = await serverUpdateService.getUpdateState();
            syncDrainDisplay(pollState.activeUsers);
            if (pollState.activeUsers === 0 && (phaseRef.current === 'draining' || phaseRef.current === 'timeout')) {
              clearAllTimers();
              await applyUpdate();
            }
          } catch {
            // keep polling
          }
        }, UPDATE_POLL_INTERVAL_MS);

        if (remainingMs > 0) {
          tickTimerRef.current = setInterval(() => {
            const elapsed = Date.now() - drainStartRef.current;
            setDrain((prev) => prev ? { ...prev, elapsedMs: elapsed } : prev);
            if (elapsed >= UPDATE_DRAIN_TIMEOUT_MS && phaseRef.current === 'draining') {
              if (tickTimerRef.current) {
                clearInterval(tickTimerRef.current);
                tickTimerRef.current = null;
              }
              setDrainPhase('timeout');
            }
          }, 200);
        } else {
          // Elapsed time already exceeded 15s — jump straight to timeout.
          setDrainPhase('timeout');
        }
      } else {
        setDrain({
          activeUsers: state.activeUsers,
          elapsedMs: 0,
          timeoutMs: UPDATE_DRAIN_TIMEOUT_MS,
        });
      }
    } catch {
      // Non-fatal.
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────
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
          applyError={applyError}
          onCancel={handleCancel}
          onSoftUpdate={handleSoftUpdate}
          onForceUpdate={handleForceUpdate}
        />
      )}
    </>
  );
}
