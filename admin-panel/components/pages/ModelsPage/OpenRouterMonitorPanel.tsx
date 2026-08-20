import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MonitorSettingsData } from '../../../lib/useOpenRouterMonitor';
import { useOpenRouterMonitorStatus } from '../../../lib/useOpenRouterMonitor';
import { FormField } from '../../ui/FormField/FormField';
import { Select, type SelectOption } from '../../ui/Select/Select';
import { Toggle } from '../../ui/Toggle/Toggle';
import styles from './ModelsPage.module.css';

const formatTime = (unix: number | null): string => {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString();
};

const STATUS_LABELS: Record<string, string> = {
  unknown: '—',
  available: 'Available',
  missing: 'Missing',
  check_failed: 'Check failed',
  model_missing: 'Model removed',
};

export function OpenRouterMonitorPanel() {
  const { t } = useTranslation();
  const { status, loading, checkModels, saveSettings } = useOpenRouterMonitorStatus();
  const [draft, setDraft] = useState<MonitorSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (status?.settings && !draft) setDraft({ ...status.settings });
  }, [status, draft]);

  if (!draft) {
    return (
      <div className={styles.sectionBody}>
        <p className={styles.empty}>
          {loading
            ? t('common.loading') || 'Loading…'
            : t('models.monitor.unavailable') ||
              'Monitor API is not available (update chatter-manager).'}
        </p>
      </div>
    );
  }

  const actionOptions: SelectOption[] = [
    { value: 'notify', label: t('models.monitor.actionNotify') || 'Notify only' },
    { value: 'cheapest', label: t('models.monitor.actionCheapest') || 'Switch to cheapest' },
    {
      value: 'throughput',
      label: t('models.monitor.actionThroughput') || 'Switch to fastest (throughput)',
    },
    { value: 'latency', label: t('models.monitor.actionLatency') || 'Switch to lowest latency' },
  ];

  const recipientOptions: SelectOption[] = [
    { value: 'all_admins', label: t('models.monitor.recipientsAll') || 'All admins with Telegram' },
    { value: 'selected', label: t('models.monitor.recipientsSelected') || 'Selected admins' },
  ];

  const admins = status?.admins || [];
  const states = status?.states || [];

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await saveSettings(draft);
    } catch (err: any) {
      setError(err?.message || 'save_failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCheckAll = async () => {
    setChecking(true);
    try {
      await checkModels();
    } catch (err: any) {
      setError(err?.message || 'check_failed');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={styles.sectionBody}>
      <div className={styles.twoColumns}>
        <FormField
          label={t('models.monitor.enabled') || 'Monitoring enabled'}
          hint={
            t('models.monitor.enabledHint') ||
            'Periodically verify that pinned OpenRouter providers still serve the model'
          }
        >
          <Toggle
            checked={draft.enabled}
            onChange={(checked) => setDraft((d) => (d ? { ...d, enabled: checked } : d))}
            label={draft.enabled ? t('common.on') || 'On' : t('common.off') || 'Off'}
          />
        </FormField>
        <FormField
          label={t('models.monitor.interval') || 'Check interval (minutes)'}
          hint={
            t('models.monitor.intervalHint') || 'Minimum 5 minutes; a small random jitter is added'
          }
        >
          <input
            type="number"
            min={5}
            step={5}
            value={draft.intervalMinutes}
            onChange={(e) =>
              setDraft((d) =>
                d ? { ...d, intervalMinutes: Math.max(5, Number(e.target.value) || 60) } : d,
              )
            }
          />
        </FormField>
      </div>

      <FormField
        label={t('models.monitor.action') || 'Action when provider disappears'}
        hint={
          t('models.monitor.actionHint') ||
          'Auto-switch happens only after two consecutive successful checks without the provider'
        }
      >
        <Select
          options={actionOptions}
          value={draft.action}
          onChange={(v) =>
            setDraft((d) => (d ? { ...d, action: v as MonitorSettingsData['action'] } : d))
          }
        />
      </FormField>

      <FormField
        label={t('models.monitor.recipients') || 'Notification recipients'}
        hint={
          t('models.monitor.recipientsHint') ||
          'Telegram notifications use the existing Chatter bot'
        }
      >
        <Select
          options={recipientOptions}
          value={draft.recipientsMode}
          onChange={(v) =>
            setDraft((d) =>
              d ? { ...d, recipientsMode: v as MonitorSettingsData['recipientsMode'] } : d,
            )
          }
        />
      </FormField>

      {draft.recipientsMode === 'selected' && (
        <div className={styles.monitorAdminField}>
          <span className={styles.monitorAdminFieldLabel}>
            {t('models.monitor.recipientAdmins') || 'Admins'}
          </span>
          {admins.length === 0 && (
            <small>{t('models.monitor.noAdmins') || 'No admins found'}</small>
          )}
          <div className={styles.monitorAdminList}>
            {admins.map((admin) => (
              <label key={admin.id} className={styles.monitorAdminItem}>
                <input
                  type="checkbox"
                  className={styles.monitorAdminCheckbox}
                  checked={draft.recipientUserIds.includes(admin.id)}
                  onChange={(e) =>
                    setDraft((d) => {
                      if (!d) return d;
                      const ids = e.target.checked
                        ? [...d.recipientUserIds, admin.id]
                        : d.recipientUserIds.filter((id) => id !== admin.id);
                      return { ...d, recipientUserIds: ids };
                    })
                  }
                />
                <span>{admin.name || `#${admin.id}`}</span>
                {!admin.hasTelegram && (
                  <small style={{ color: 'var(--color-muted)' }}>
                    {' '}
                    · {t('models.monitor.noTelegram') || 'no Telegram'}
                  </small>
                )}
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" disabled={saving} onClick={() => void handleSave()}>
          {saving
            ? t('common.saving') || 'Saving…'
            : t('models.monitor.saveSettings') || 'Save monitoring settings'}
        </button>
        <button
          type="button"
          className="buttonSecondary"
          disabled={checking}
          onClick={() => void handleCheckAll()}
        >
          {checking
            ? t('models.monitor.checking') || 'Checking…'
            : t('models.monitor.checkAll') || 'Check all now'}
        </button>
        {error && <small style={{ color: 'var(--color-danger, #e5484d)' }}>{error}</small>}
      </div>

      {states.length > 0 && (
        <details className={styles.monitorStates}>
          <summary>{t('models.monitor.statesTitle') || 'Monitored models status'}</summary>
          <table className={styles.monitorTable}>
            <thead>
              <tr>
                <th>{t('models.monitor.colModel') || 'Model'}</th>
                <th>Route</th>
                <th>{t('models.monitor.colProvider') || 'Provider'}</th>
                <th>{t('models.monitor.colStatus') || 'Status'}</th>
                <th>{t('models.monitor.colLastCheck') || 'Last checked'}</th>
              </tr>
            </thead>
            <tbody>
              {states.map((s) => (
                <tr key={s.model_id}>
                  <td>{s.model_slug || s.model_id}</td>
                  <td>{s.route || '—'}</td>
                  <td>{s.provider_slug || '—'}</td>
                  <td>
                    <span
                      className={`${styles.monitorBadge} ${styles[`monitor_${s.status}`] || ''}`}
                    >
                      {STATUS_LABELS[s.status] || s.status}
                    </span>
                    {s.status === 'missing' && s.consecutive_missing > 0 && (
                      <small> ×{s.consecutive_missing}</small>
                    )}
                  </td>
                  <td>{formatTime(s.last_check_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
