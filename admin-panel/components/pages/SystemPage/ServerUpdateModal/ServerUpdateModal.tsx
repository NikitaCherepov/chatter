'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ServerUpdateModal.module.css';

export function ServerUpdateModal({ changelog, changedServices, rebuiltFromSameCommit, updating, onCancel, onConfirm }: {
  changelog: Record<string, string[]>;
  changedServices: string[];
  rebuiltFromSameCommit: boolean;
  updating: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !updating) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, updating]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !updating) onCancel();
    }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="server-update-title">
        <h2 id="server-update-title">{t('system.update.title')}</h2>
        {rebuiltFromSameCommit && <p className={styles.notice}>{t('system.update.changes.rebuiltFromSame')}</p>}
        <h3>{t('system.update.changes.whatsNew')}</h3>
        <pre className={styles.changelog}>{JSON.stringify({ changes: changelog }, null, 2)}</pre>
        <p>{t('system.update.changes.services')}: {changedServices.join(', ')}</p>
        <p>{t('system.update.changes.autoBackup')}</p>
        <div className={styles.actions}>
          <button type="button" className="buttonSecondary" onClick={onCancel} disabled={updating}>{t('system.update.changes.cancel')}</button>
          <button type="button" onClick={onConfirm} disabled={updating}>{updating ? t('system.update.changes.updating') : t('system.update.changes.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
