'use client';

import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ServerUpdateModal.module.css';

export type DrainState = {
  activeUsers: number;
  elapsedMs: number;
  timeoutMs: number;
};

export function ServerUpdateModal({ changelog, rebuiltFromSameCommit, updating, operationStatus, operationMessage, drainPhase, drain, onCancel, onSoftUpdate, onForceUpdate }: {
  changelog: Record<string, string[]>;
  rebuiltFromSameCommit: boolean;
  updating: boolean;
  operationStatus: string;
  operationMessage: string;
  drainPhase: 'none' | 'draining' | 'updating';
  drain: DrainState | null;
  onCancel: () => void;
  onSoftUpdate: () => void;
  onForceUpdate: () => void;
}) {
  const { t, i18n } = useTranslation();

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
  const showProgress = updating || terminal;
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

  // Escape closes the modal. During `updating` we ignore Escape — closing
  // mid-apply would be misleading since apply can't be cancelled.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !updating) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, updating]);

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
    if (event.target !== event.currentTarget || updating) return;
    onCancel();
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onBackdropClick}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="server-update-title">
        <h2 id="server-update-title">{t('system.update.title')}</h2>

        {/* Active users count + drain progress (shown whenever drain snapshot exists) */}
        {drain && (
          <div className={styles.drainSection}>
            {drainPhase === 'draining' && drain.activeUsers > 0 && (
              <>
                <p className={styles.drainText}>
                  {t('system.update.drain.waiting', { count: drain.activeUsers, seconds: drainSecondsLeft })}
                </p>
                <div className={styles.drainBar}>
                  <div
                    className={styles.drainFill}
                    style={{ width: `${Math.min(100, (drain.elapsedMs / drain.timeoutMs) * 100)}%` }}
                  />
                </div>
              </>
            )}
            {drainPhase === 'none' && (
              <p className={styles.drainText}>
                {drain.activeUsers > 0
                  ? t('system.update.drain.activeUsers', { count: drain.activeUsers })
                  : t('system.update.drain.noActive')}
              </p>
            )}
            {drainPhase === 'draining' && drain.activeUsers === 0 && (
              <p className={styles.drainDone}>{t('system.update.drain.allDone')}</p>
            )}
          </div>
        )}

        {/* Changelog (only before update starts) */}
        {drainPhase === 'none' && (
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

        {/* Progress bar during update */}
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

        {/* Actions */}
        <div className={styles.actions}>
          {updating ? (
            <button type="button" disabled>{t('system.update.changes.updating')}</button>
          ) : terminal ? (
            <button type="button" onClick={onCancel}>{t('system.update.changes.cancel')}</button>
          ) : (
            <>
              {/* Cancel: always available (closes modal, clears drain if active) */}
              <button type="button" className="buttonSecondary" onClick={onCancel}>
                {t('system.update.changes.cancel')}
              </button>
              {/* Soft update: set flag, abort active generations, wait up to 15s for HITL, then apply */}
              <button
                type="button"
                className="buttonSecondary"
                onClick={onSoftUpdate}
                disabled={drainPhase === 'draining'}
              >
                {t('system.update.drain.softUpdate')}
              </button>
              {/* Force update: abort everything immediately and apply */}
              <button type="button" onClick={onForceUpdate} disabled={drainPhase === 'draining'}>
                {t('system.update.drain.forceNow')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
