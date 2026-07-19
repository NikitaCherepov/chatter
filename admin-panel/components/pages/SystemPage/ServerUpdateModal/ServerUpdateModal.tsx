'use client';

import { useEffect } from 'react';
import styles from './ServerUpdateModal.module.css';

export function ServerUpdateModal({ changelog, changedServices, rebuiltFromSameCommit, updating, onCancel, onConfirm }: {
  changelog: Record<string, string[]>;
  changedServices: string[];
  rebuiltFromSameCommit: boolean;
  updating: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
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
        <h2 id="server-update-title">Обновление сервера</h2>
        {rebuiltFromSameCommit && <p className={styles.notice}>Образы пересобраны из того же коммита.</p>}
        <h3>Что изменилось</h3>
        <pre className={styles.changelog}>{JSON.stringify({ changes: changelog }, null, 2)}</pre>
        <p>Сервисы: {changedServices.join(', ')}</p>
        <p>Перед перезапуском автоматически создастся резервная копия базы данных.</p>
        <div className={styles.actions}>
          <button type="button" className="buttonSecondary" onClick={onCancel} disabled={updating}>Отмена</button>
          <button type="button" onClick={onConfirm} disabled={updating}>{updating ? 'Запускаем…' : 'Обновить сервер'}</button>
        </div>
      </div>
    </div>
  );
}
