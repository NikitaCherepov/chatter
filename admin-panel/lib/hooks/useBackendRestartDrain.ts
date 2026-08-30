'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  serverUpdateService,
  UPDATE_DRAIN_TIMEOUT_MS,
  UPDATE_POLL_INTERVAL_MS,
} from '../services/serverUpdateService';
import type { DrainPhase, DrainState } from '../../components/pages/SystemPage/ServerUpdateModal/ServerUpdateModal';

type Options = {
  apply: () => Promise<void>;
  closeOnSuccess?: boolean;
  onError?: (error: string) => void;
};

export function useBackendRestartDrain({ apply, closeOnSuccess = false, onError }: Options) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DrainPhase>('idle');
  const [drain, setDrain] = useState<DrainState | null>(null);
  const [error, setError] = useState('');
  const applyRef = useRef(apply);
  const onErrorRef = useRef(onError);
  const phaseRef = useRef<DrainPhase>('idle');
  const preparedRef = useRef(false);
  const applyingRef = useRef(false);
  const drainStartRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { applyRef.current = apply; }, [apply]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    pollTimerRef.current = null;
    tickTimerRef.current = null;
  }, []);

  useEffect(() => () => {
    clearTimers();
    if (preparedRef.current && !applyingRef.current) {
      serverUpdateService.cancelUpdate().catch(() => { /* best-effort */ });
    }
  }, [clearTimers]);

  const syncDrain = useCallback((activeUsers: number) => {
    setDrain({
      activeUsers,
      elapsedMs: Date.now() - drainStartRef.current,
      timeoutMs: UPDATE_DRAIN_TIMEOUT_MS,
    });
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    preparedRef.current = false;
    applyingRef.current = false;
    phaseRef.current = 'idle';
    setPhase('idle');
    setDrain(null);
    setError('');
  }, [clearTimers]);

  const runApply = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    clearTimers();
    setError('');
    phaseRef.current = 'applying';
    setPhase('applying');
    try {
      await applyRef.current();
      preparedRef.current = false;
      if (closeOnSuccess) {
        setOpen(false);
        reset();
      }
    } catch (cause) {
      applyingRef.current = false;
      const message = cause instanceof Error ? cause.message : String(cause);
      phaseRef.current = 'idle';
      setError(message);
      setPhase('idle');
      onErrorRef.current?.(message);
    }
  }, [clearTimers, closeOnSuccess, reset]);

  const startPolling = useCallback(() => {
    pollTimerRef.current = setInterval(async () => {
      try {
        const state = await serverUpdateService.getUpdateState();
        syncDrain(state.activeUsers);
        if (state.activeUsers === 0 && (phaseRef.current === 'draining' || phaseRef.current === 'timeout')) {
          await runApply();
        }
      } catch {
        // A backend restart may briefly interrupt polling. Keep waiting.
      }
    }, UPDATE_POLL_INTERVAL_MS);

    tickTimerRef.current = setInterval(() => {
      const elapsedMs = Date.now() - drainStartRef.current;
      setDrain((current) => current ? { ...current, elapsedMs } : current);
      if (elapsedMs >= UPDATE_DRAIN_TIMEOUT_MS && phaseRef.current === 'draining') {
        if (tickTimerRef.current) clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
        setPhase('timeout');
      }
    }, 200);
  }, [runApply, syncDrain]);

  const show = useCallback(async () => {
    clearTimers();
    setError('');
    setOpen(true);
    setPhase('idle');
    setDrain({ activeUsers: 0, elapsedMs: 0, timeoutMs: UPDATE_DRAIN_TIMEOUT_MS });
    try {
      const state = await serverUpdateService.getUpdateState();
      if (!state.preparing) {
        setDrain({ activeUsers: state.activeUsers, elapsedMs: 0, timeoutMs: UPDATE_DRAIN_TIMEOUT_MS });
        return;
      }

      preparedRef.current = true;
      drainStartRef.current = Date.now() - state.elapsedMs;
      phaseRef.current = state.elapsedMs >= UPDATE_DRAIN_TIMEOUT_MS ? 'timeout' : 'draining';
      setPhase(phaseRef.current);
      syncDrain(state.activeUsers);
      if (state.activeUsers === 0) {
        await runApply();
        return;
      }
      startPolling();
    } catch {
      // The modal can still be used; prepare will report a concrete error.
    }
  }, [clearTimers, runApply, startPolling, syncDrain]);

  const soft = useCallback(async () => {
    if (phaseRef.current !== 'idle') return;
    drainStartRef.current = Date.now();
    phaseRef.current = 'draining';
    setPhase('draining');
    setDrain({ activeUsers: 0, elapsedMs: 0, timeoutMs: UPDATE_DRAIN_TIMEOUT_MS });
    try {
      const state = await serverUpdateService.prepareUpdate();
      preparedRef.current = true;
      syncDrain(state.activeUsers);
      if (state.activeUsers === 0) {
        await runApply();
        return;
      }
      startPolling();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      phaseRef.current = 'idle';
      setPhase('idle');
      onErrorRef.current?.(message);
    }
  }, [runApply, startPolling, syncDrain]);

  const force = useCallback(async () => {
    clearTimers();
    try {
      await serverUpdateService.prepareUpdate();
      preparedRef.current = true;
      await serverUpdateService.forceUpdate();
      await runApply();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      phaseRef.current = 'idle';
      setPhase('idle');
      onErrorRef.current?.(message);
    }
  }, [clearTimers, runApply]);

  const cancel = useCallback(async () => {
    clearTimers();
    if (preparedRef.current && phaseRef.current !== 'applying') {
      try { await serverUpdateService.cancelUpdate(); } catch { /* best-effort */ }
    }
    preparedRef.current = false;
    applyingRef.current = false;
    phaseRef.current = 'idle';
    setOpen(false);
    reset();
  }, [clearTimers, reset]);

  return { open, phase, drain, error, show, soft, force, cancel, retry: runApply };
}
