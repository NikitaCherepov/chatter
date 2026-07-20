'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import { Toggle } from '../../ui/Toggle/Toggle';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import styles from './PlanLimitsPage.module.css';

type PlanLimits = {
  daily_web_search_limit: number;
  daily_image_gen_limit: number;
  image_attachments_allowed: boolean;
  max_context_tokens: number;
  weekly_token_quota: number;
};

type PlanLimitsData = Record<'free' | 'standart' | 'pro', PlanLimits>;

const emptyLimits: PlanLimitsData = {
  free: { daily_web_search_limit: 0, daily_image_gen_limit: 0, image_attachments_allowed: false, max_context_tokens: 30000, weekly_token_quota: 5_000_000 },
  standart: { daily_web_search_limit: 5, daily_image_gen_limit: 2, image_attachments_allowed: true, max_context_tokens: 60000, weekly_token_quota: 15_000_000 },
  pro: { daily_web_search_limit: 20, daily_image_gen_limit: 5, image_attachments_allowed: true, max_context_tokens: 1_000_000, weekly_token_quota: 30_000_000 },
};

const PLAN_IDS: ('free' | 'standart' | 'pro')[] = ['free', 'standart', 'pro'];

const formatNumber = (value: number) => new Intl.NumberFormat('ru').format(Number(value) || 0);

export function PlanLimitsPage() {
  const { t } = useTranslation();
  const [limits, setLimits] = useState<PlanLimitsData>(emptyLimits);
  const [state, setState] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api<{ limits: PlanLimitsData }>('/api/plan-limits');
      if (response.limits) setLimits({ ...emptyLimits, ...response.limits });
    } catch (err) {
      setState(t('planLimits.loadError', { message: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const update = (plan: 'free' | 'standart' | 'pro', patch: Partial<PlanLimits>) => {
    setLimits(current => ({ ...current, [plan]: { ...current[plan], ...patch } }));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setState(t('planLimits.actions.saving'));
    try {
      await api('/api/plan-limits', { method: 'PUT', body: JSON.stringify({ limits }) });
      setState(t('planLimits.saved'));
    } catch (err) {
      setState(t('planLimits.loadError', { message: err instanceof Error ? err.message : String(err) }));
    } finally { setSaving(false); }
  }

  async function syncAll() {
    if (!window.confirm(t('planLimits.syncConfirm'))) return;
    setState(t('planLimits.syncing'));
    try {
      await api('/api/sync-plan-limits', { method: 'POST', body: '{}' });
      setState(t('planLimits.synced'));
    } catch (err) {
      setState(t('planLimits.loadError', { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  return (
    <form className={grid.stack} onSubmit={save} noValidate>
      {PLAN_IDS.map(id => {
        const cfg = limits[id];
        return (
          <Card key={id} title={t('planLimits.planTitle', { label: t(`planLimits.plans.${id}.label`) })} description={t(`planLimits.plans.${id}.hint`)}>
            <div className={styles.row}>
              <FormField
                label={t('planLimits.weeklyQuotaLabel')}
                hint={t('planLimits.weeklyQuotaHint', { units: formatNumber(cfg.weekly_token_quota) })}
              >
                <input
                  type="number"
                  min={0}
                  step={100_000}
                  value={cfg.weekly_token_quota}
                  onChange={(e) => update(id, { weekly_token_quota: Math.max(0, Number(e.target.value) || 0) })}
                />
              </FormField>
              <FormField label={t('planLimits.contextLimitLabel')}>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={cfg.max_context_tokens}
                  onChange={(e) => update(id, { max_context_tokens: Math.max(0, Number(e.target.value) || 0) })}
                />
              </FormField>
            </div>
            <div className={styles.row}>
              <FormField label={t('planLimits.webSearchLabel')}>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={cfg.daily_web_search_limit}
                  onChange={(e) => update(id, { daily_web_search_limit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </FormField>
              <FormField label={t('planLimits.imageGenLabel')}>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={cfg.daily_image_gen_limit}
                  onChange={(e) => update(id, { daily_image_gen_limit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </FormField>
            </div>
            <div className={styles.toggleRow}>
              <Toggle
                checked={cfg.image_attachments_allowed}
                onChange={(image_attachments_allowed) => update(id, { image_attachments_allowed })}
                label={t('planLimits.allowImageAttach')}
              />
            </div>
          </Card>
        );
      })}

      <Card title={t('planLimits.actions.title')} description={t('planLimits.actions.description')}>
        <div className={styles.actions}>
          <button type="submit" className="buttonPrimary" disabled={saving}>
            {saving ? t('planLimits.actions.saving') : t('planLimits.actions.saveLimits')}
          </button>
          <button type="button" className="buttonSecondary" onClick={() => void syncAll()} disabled={saving}>
            {t('planLimits.actions.syncAll')}
          </button>
        </div>
        {state && <p className={styles.state}>{state}</p>}
      </Card>
    </form>
  );
}
