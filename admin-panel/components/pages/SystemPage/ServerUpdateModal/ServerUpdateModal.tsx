'use client';

import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ServerUpdateModal.module.css';

export type DrainState = {
  activeUsers: number;
  elapsedMs: number;
  timeoutMs: number;
};

// 4-phase state machine:
// idle     — modal open, no action taken yet
// draining — prepareUpdate called, flag set, polling + 15s timer running
// timeout  — 15s elapsed, activeUsers > 0, only Force/Cancel available
// applying — applyUpdate in progress
export type DrainPhase = 'idle' | 'draining' | 'timeout' | 'applying';

export function ServerUpdateModal({
  mode = 'update',
  changelog,
  rebuiltFromSameCommit,
  updating,
  operationStatus,
  operationMessage,
  drainPhase,
  drain,
  applyError,
  onCancel,
  onRetry,
  onSoftUpdate,
  onForceUpdate,
}: {
  mode?: 'update' | 'configuration';
  changelog: Record<string, string[]>;
  rebuiltFromSameCommit: boolean;
  updating: boolean;
  operationStatus: string;
  operationMessage: string;
  drainPhase: DrainPhase;
  drain: DrainState | null;
  applyError: string;
  onCancel: () => void;
  onRetry: () => void;
  onSoftUpdate: () => void;
  onForceUpdate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isConfiguration = mode === 'configuration';

  const stageProgress: Record<string, number> = {
    queued: 10,
    backup: 40,
    restarting: 75,
    complete: 100,
    failed: 100,
  };
  const activeStatuses = new Set(['queued', 'backup', 'restarting', 'complete', 'failed']);
  const effectiveStatus = operationStatus === 'idle' && updating ? 'queued' : operationStatus;
  const stageKey = effectiveStatus && activeStatuses.has(effectiveStatus) ? `system.update.stages.${effectiveStatus}` : null;
  const terminal = effectiveStatus === 'complete' || effectiveStatus === 'failed';
  const showProgress = !isConfiguration && (updating || terminal);
  const progressPercent = stageProgress[effectiveStatus] ?? 0;
  const failed = effectiveStatus === 'failed';

  const releaseNotes = useMemo(() => {
    const available = Object.keys(changelog);
    const lang = (i18n.language || 'en').replace('_', '-').toLowerCase();
    const baseLang = lang.split('-')[0];

    const match =
      available.find((l) => l.toLowerCase() === lang) ??
      available.find((l) => l.toLowerCase().startsWith(baseLang)) ??
      'en';

    const entries = changelog[match] ?? changelog['en'] ?? [];
    return entries.map((entry) => `• ${entry}`).join('\n');
  }, [changelog, i18n.language]);

  // Escape closes modal unless update is in progress.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drainPhase !== 'applying') onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, drainPhase]);

  useEffect(() => {
    if (effectiveStatus === 'complete') {
      const timer = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(timer);
    }
  }, [effectiveStatus]);

  const drainSecondsLeft = drain
    ? Math.max(0, Math.ceil((drain.timeoutMs - drain.elapsedMs) / 1000))
    : 0;

  const onBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || drainPhase === 'applying') return;
    onCancel();
  };

  // Show drain section in all phases except applying.
  const showDrainSection = drain && drainPhase !== 'applying';

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onBackdropClick}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="server-update-title">
        <h2 id="server-update-title">
          {t(isConfiguration ? 'system.update.restart.title' : 'system.update.title')}
        </h2>

        {/* ─── Drain status ─────────────────────────────────────────────── */}
        {showDrainSection && (
          <div className={styles.drainSection}>
            {/* idle: show active users count before any action */}
            {drainPhase === 'idle' && (
              <p className={styles.drainText}>
                {drain!.activeUsers > 0
                  ? t('system.update.drain.activeUsers', { count: drain!.activeUsers })
                  : t('system.update.drain.noActive')}
              </p>
            )}

            {/* draining + still active: progress bar + count */}
            {drainPhase === 'draining' && drain!.activeUsers > 0 && (
              <>
                <p className={styles.drainText}>
                  {t('system.update.drain.waiting', { count: drain!.activeUsers, seconds: drainSecondsLeft })}
                </p>
                <div className={styles.drainBar}>
                  <div
                    className={styles.drainFill}
                    style={{ width: `${Math.min(100, (drain!.elapsedMs / drain!.timeoutMs) * 100)}%` }}
                  />
                </div>
              </>
            )}

            {/* timeout: 15s passed, still have users */}
            {drainPhase === 'timeout' && (
              <p className={styles.drainTimeoutNotice}>
                {t(isConfiguration ? 'system.update.restart.timeoutNotice' : 'system.update.drain.timeoutNotice', { count: drain!.activeUsers })}
              </p>
            )}
          </div>
        )}

        {/* ─── Changelog (only in idle phase) ──────────────────────────── */}
        {drainPhase === 'idle' && (
          <>
            {isConfiguration ? (
              <p>{t('system.update.restart.description')}</p>
            ) : (
              <>
            {rebuiltFromSameCommit && <p className={styles.notice}>{t('system.update.changes.rebuiltFromSame')}</p>}
            {releaseNotes && (
              <>
                <h3>{t('system.update.changes.whatsNew')}</h3>
                <div className={styles.changelog}>{releaseNotes}</div>
              </>
            )}
            <p>{t('system.update.changes.autoBackup')}</p>
              </>
            )}
          </>
        )}

        {/* ─── Apply error ─────────────────────────────────────────────── */}
        {applyError && (
          <p className={styles.notice}>{applyError}</p>
        )}

        {/* ─── Progress bar (during applying / terminal) ───────────────── */}
        {showProgress && stageKey && (
          <div className={styles.progressSection}>
            <div className={styles.progressBar}>
              <div
                className={`${styles.progressFill} ${failed ? styles.progressFillError : ''}`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className={styles.progressText}>
              {t(stageKey)}{operationMessage && failed ? ` ${operationMessage}` : ''}
            </div>
          </div>
        )}

        {/* ─── Action buttons ──────────────────────────────────────────── */}
        <div className={styles.actions}>
          {drainPhase === 'applying' ? (
            <button type="button" disabled>
              {t(isConfiguration ? 'system.update.restart.applying' : 'system.update.changes.updating')}
            </button>
          ) : terminal ? (
            <>
              <button type="button" className="buttonSecondary" onClick={onCancel}>
                {t('system.update.changes.cancel')}
              </button>
              {failed && (
                <button type="button" onClick={onRetry}>
                  {t('system.update.changes.retry')}
                </button>
              )}
            </>
          ) : (
            <>
              {/* Cancel: always available unless applying */}
              <button type="button" className="buttonSecondary" onClick={onCancel}>
                {t('system.update.changes.cancel')}
              </button>

              {/* Soft: only in idle phase */}
              <button
                type="button"
                className="buttonSecondary"
                onClick={onSoftUpdate}
                disabled={drainPhase !== 'idle'}
              >
                {t(isConfiguration ? 'system.update.restart.softApply' : 'system.update.drain.softUpdate')}
              </button>

              {/* Force: available in idle, draining, AND timeout phases.
                  We're already in the `else` branch (not applying, not terminal),
                  so no disabled condition needed. */}
              <button
                type="button"
                onClick={onForceUpdate}
              >
                {t(isConfiguration ? 'system.update.restart.forceApply' : 'system.update.drain.forceNow')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
