'use client';

import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ServerUpdateModal.module.css';

export function ServerUpdateModal({ changelog, rebuiltFromSameCommit, updating, operationStatus, operationMessage, onCancel, onConfirm }: {
  changelog: Record<string, string[]>;
  rebuiltFromSameCommit: boolean;
  updating: boolean;
  operationStatus: string;
  operationMessage: string;
  onCancel: () => void;
  onConfirm: () => void;
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
  const stageKey = operationStatus && activeStatuses.has(operationStatus) ? `system.update.stages.${operationStatus}` : null;
  const showProgress = updating;
  const progressPercent = stageProgress[operationStatus] ?? 0;
  const failed = operationStatus === 'failed';

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

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !updating) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, updating]);

  useEffect(() => {
    if (operationStatus === 'complete') {
      const timer = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(timer);
    }
  }, [operationStatus]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !updating) onCancel();
    }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="server-update-title">
        <h2 id="server-update-title">{t('system.update.title')}</h2>
        {rebuiltFromSameCommit && <p className={styles.notice}>{t('system.update.changes.rebuiltFromSame')}</p>}
        {releaseNotes && (
          <>
            <h3>{t('system.update.changes.whatsNew')}</h3>
            <div className={styles.changelog}>{releaseNotes}</div>
          </>
        )}
        <p>{t('system.update.changes.autoBackup')}</p>
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
        <div className={styles.actions}>
          {showProgress ? (
            <button type="button" onClick={onCancel}>{t('system.update.changes.cancel')}</button>
          ) : (
            <>
              <button type="button" className="buttonSecondary" onClick={onCancel}>{t('system.update.changes.cancel')}</button>
              <button type="button" onClick={onConfirm}>{t('system.update.changes.confirm')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
