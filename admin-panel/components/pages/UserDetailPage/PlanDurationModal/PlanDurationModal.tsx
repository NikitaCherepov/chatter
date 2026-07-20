'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '../../../ui/Select/Select';
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
  const { t } = useTranslation();
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
        <h2 id="plan-duration-title">{t('users.planDuration.title', { plan: planNames[plan] })}</h2>
        <p>{plan === 'free' ? t('users.planDuration.freeHint') : t('users.planDuration.durationHint')}</p>
        <label>
          <span>{t('users.planDuration.durationLabel')}</span>
          <Select
            value={duration}
            onChange={(value) => setDuration(value as PlanDuration)}
            disabled={saving || plan === 'free'}
            options={[
              ...(plan !== 'free' ? [
                { value: 'day', label: t('users.planDuration.durationDay') },
                { value: 'week', label: t('users.planDuration.durationWeek') },
                { value: 'month', label: t('users.planDuration.durationMonth') },
                { value: 'year', label: t('users.planDuration.durationYear') },
              ] : []),
              { value: 'forever', label: t('users.planDuration.forever') },
            ]}
          />
        </label>
        <div className={styles.actions}>
          <button type="button" className="buttonSecondary" onClick={onCancel} disabled={saving}>{t('users.planDuration.cancel')}</button>
          <button type="button" onClick={() => onConfirm(plan === 'free' ? 'forever' : duration)} disabled={saving}>
            {saving ? t('users.planDuration.saving') : t('users.planDuration.assign')}
          </button>
        </div>
      </div>
    </div>
  );
}
