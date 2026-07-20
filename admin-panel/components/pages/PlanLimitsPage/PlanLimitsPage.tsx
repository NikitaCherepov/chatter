'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
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

const PLAN_LABELS: { id: 'free' | 'standart' | 'pro'; label: string; hint: string }[] = [
  { id: 'free', label: 'Free', hint: 'Базовые пользователи без подписки' },
  { id: 'standart', label: 'Standart', hint: 'Стандартная подписка' },
  { id: 'pro', label: 'Pro', hint: 'Премиум-подписка' },
];

const formatNumber = (value: number) => new Intl.NumberFormat('ru').format(Number(value) || 0);

export function PlanLimitsPage() {
  const [limits, setLimits] = useState<PlanLimitsData>(emptyLimits);
  const [state, setState] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api<{ limits: PlanLimitsData }>('/api/v1/admin/plan-limits');
      if (response.limits) setLimits({ ...emptyLimits, ...response.limits });
    } catch (err) {
      setState(`Не удалось загрузить лимиты: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const update = (plan: 'free' | 'standart' | 'pro', patch: Partial<PlanLimits>) => {
    setLimits(current => ({ ...current, [plan]: { ...current[plan], ...patch } }));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setState('Сохраняю…');
    try {
      await api('/api/v1/admin/plan-limits', { method: 'PUT', body: JSON.stringify({ limits }) });
      setState('Лимиты сохранены. Новые подписки получат обновлённые значения автоматически. Существующим пользователям нажмите «Синхронизировать».');
    } catch (err) {
      setState(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setSaving(false); }
  }

  async function syncAll() {
    if (!window.confirm('Применить текущие лимиты ко всем существующим пользователям? Это обновит daily_web_search_limit, daily_image_gen_limit, max_context_tokens и weekly_tokens_quota.')) return;
    setState('Синхронизирую…');
    try {
      await api('/api/v1/admin/sync-plan-limits', { method: 'POST', body: '{}' });
      setState('Лимиты синхронизированы для всех пользователей.');
    } catch (err) {
      setState(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <form className={grid.stack} onSubmit={save} noValidate>
      {PLAN_LABELS.map(({ id, label, hint }) => {
        const cfg = limits[id];
        return (
          <Card key={id} title={`Тариф: ${label}`} description={hint}>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Недельная квота токенов</span>
                <input
                  type="number"
                  min={0}
                  step={100_000}
                  value={cfg.weekly_token_quota}
                  onChange={(e) => update(id, { weekly_token_quota: Math.max(0, Number(e.target.value) || 0) })}
                />
                <small>~{formatNumber(cfg.weekly_token_quota)} условных единиц в неделю. 0 = нет квоты (только флаги).</small>
              </label>
              <label className={styles.field}>
                <span>Лимит контекста (токенов)</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={cfg.max_context_tokens}
                  onChange={(e) => update(id, { max_context_tokens: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            </div>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Web-поиск в день</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={cfg.daily_web_search_limit}
                  onChange={(e) => update(id, { daily_web_search_limit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label className={styles.field}>
                <span>Генераций картинок в день</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={cfg.daily_image_gen_limit}
                  onChange={(e) => update(id, { daily_image_gen_limit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            </div>
            <div className={styles.toggleRow}>
              <Toggle
                checked={cfg.image_attachments_allowed}
                onChange={(image_attachments_allowed) => update(id, { image_attachments_allowed })}
                label="Разрешить прикреплять изображения"
              />
            </div>
          </Card>
        );
      })}

      <Card title="Действия" description="Применить лимиты ко всем текущим пользователям">
        <div className={styles.actions}>
          <button type="submit" className="buttonPrimary" disabled={saving}>
            {saving ? 'Сохраняю…' : 'Сохранить лимиты'}
          </button>
          <button type="button" className="buttonSecondary" onClick={() => void syncAll()} disabled={saving}>
            Синхронизировать всем пользователям
          </button>
        </div>
        {state && <p className={styles.state}>{state}</p>}
      </Card>
    </form>
  );
}
