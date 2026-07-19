'use client';

import { useEffect, useState } from 'react';
import styles from './PlanDurationModal.module.css';

export type UserPlan = 'free' | 'standart' | 'pro';
export type PlanDuration = 'day' | 'week' | 'month' | 'year' | 'forever';

const planNames: Record<UserPlan, string> = {
  free: 'Free',
  standart: 'Standard',
  pro: 'Pro',
};

export function PlanDurationModal({
  plan,
  saving,
  onCancel,
  onConfirm,
}: {
  plan: UserPlan;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (duration: PlanDuration) => void;
}) {
  const [duration, setDuration] = useState<PlanDuration>(plan === 'free' ? 'forever' : 'month');

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, saving]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !saving) onCancel();
    }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="plan-duration-title">
        <h2 id="plan-duration-title">Тариф {planNames[plan]}</h2>
        <p>{plan === 'free' ? 'Бесплатный тариф устанавливается бессрочно.' : 'На какой срок назначить тариф?'}</p>
        <label>
          <span>Срок</span>
          <select
            value={duration}
            onChange={event => setDuration(event.target.value as PlanDuration)}
            disabled={saving || plan === 'free'}
          >
            {plan !== 'free' && <option value="day">1 день</option>}
            {plan !== 'free' && <option value="week">1 неделя</option>}
            {plan !== 'free' && <option value="month">1 месяц</option>}
            {plan !== 'free' && <option value="year">1 год</option>}
            <option value="forever">Бессрочно</option>
          </select>
        </label>
        <div className={styles.actions}>
          <button type="button" className="buttonSecondary" onClick={onCancel} disabled={saving}>Отмена</button>
          <button type="button" onClick={() => onConfirm(plan === 'free' ? 'forever' : duration)} disabled={saving}>
            {saving ? 'Сохраняю…' : 'Назначить'}
          </button>
        </div>
      </div>
    </div>
  );
}
