'use client';

import type { ReactNode } from 'react';
import styles from './ConfirmModal.module.css';

export type ConfirmModalAction = {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: 'primary' | 'danger' | 'secondary';
  disabled?: boolean;
};

export function ConfirmModal({ title, children, actions, onClose }: {
  title: string;
  children: ReactNode;
  actions: ConfirmModalAction[];
  onClose: () => void;
}) {
  return (
    <div className={styles.overlay} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
        <h2 id="confirm-modal-title">{title}</h2>
        <div className={styles.content}>{children}</div>
        <div className={styles.actions}>
          {actions.map((action, index) => (
            <button
              key={`${action.label}-${index}`}
              type="button"
              className={styles[action.variant || 'secondary']}
              disabled={action.disabled}
              onClick={() => void action.onClick()}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
