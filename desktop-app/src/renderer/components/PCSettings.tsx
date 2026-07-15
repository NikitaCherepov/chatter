import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';

type PcSettings = {
  fs_scan_enabled: boolean;
  auto_approve_all: boolean;
  file_read_enabled: boolean;
};

type PcPolicy = {
  id: number;
  pattern: string;
  auto_approve: boolean;
  created_at: number;
};

export function PCSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PcSettings>({ fs_scan_enabled: false, auto_approve_all: false, file_read_enabled: true });
  const [policies, setPolicies] = useState<PcPolicy[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sRes, pRes] = await Promise.all([
        api.apiFetch<PcSettings>('/api/v1/pc-commands/settings'),
        api.apiFetch<{ policies: PcPolicy[] }>('/api/v1/pc-commands/policies'),
      ]);
      setSettings(sRes);
      setPolicies(pRes.policies || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateSetting = async (key: keyof PcSettings, value: boolean) => {
    setSaving(true);
    try {
      await api.apiFetch('/api/v1/pc-commands/settings', {
        method: 'PUT',
        body: JSON.stringify({ [key]: value }),
      });
      setSettings(prev => ({ ...prev, [key]: value }));
    } catch {
      // revert on error
    } finally {
      setSaving(false);
    }
  };

  const handleAddPolicy = async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    try {
      const res = await api.apiFetch<{ id: number }>('/api/v1/pc-commands/policies', {
        method: 'POST',
        body: JSON.stringify({ pattern }),
      });
      setPolicies(prev => [...prev, { id: res.id, pattern, auto_approve: true, created_at: Math.floor(Date.now() / 1000) }]);
      setNewPattern('');
    } catch {
      // ignore
    }
  };

  const handleDeletePolicy = async (policyId: number) => {
    try {
      await api.apiFetch(`/api/v1/pc-commands/policies/${policyId}`, { method: 'DELETE' });
      setPolicies(prev => prev.filter(p => p.id !== policyId));
    } catch {
      // ignore
    }
  };

  if (loading) {
    return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;
  }

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('settings.sections.pc')}</div>

      {/* Settings toggles */}
      <div className={s.fieldGroup}>
        <label className={s.macroToggleLabel}>
          <input
            type="checkbox"
            checked={settings.fs_scan_enabled}
            onChange={(e) => updateSetting('fs_scan_enabled', e.target.checked)}
            className={s.macroCheckbox}
            disabled={saving}
          />
          <span className={s.fieldLabel} style={{ color: 'var(--text-body)' }}>
            {t('advanced.pc.scanFilesystem')}
          </span>
        </label>
      </div>

      <div className={s.fieldGroup}>
        <label className={s.macroToggleLabel}>
          <input
            type="checkbox"
            checked={settings.file_read_enabled}
            onChange={(e) => updateSetting('file_read_enabled', e.target.checked)}
            className={s.macroCheckbox}
            disabled={saving}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-body)' }}>
              {t('advanced.pc.readWithoutConfirmation')}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {t('advanced.pc.readHelp')}
            </span>
          </div>
        </label>
      </div>

      <div className={s.fieldGroup}>
        <label className={s.macroToggleLabel}>
          <input
            type="checkbox"
            checked={settings.auto_approve_all}
            onChange={(e) => updateSetting('auto_approve_all', e.target.checked)}
            className={s.macroCheckbox}
            disabled={saving}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: '#e74c3c' }}>
              {t('advanced.pc.autoApproveAll')}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {t('advanced.pc.autoApproveHelp')}
            </span>
          </div>
        </label>
      </div>

      <div className={s.macroFormDivider} />

      {/* Auto-approve policies */}
      <div className={s.fieldGroup}>
        <span className={s.fieldLabel} style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px', display: 'block' }}>
          {t('advanced.pc.allowedCommands')}
        </span>
        <span className={s.fieldLabel} style={{ marginBottom: '8px', display: 'block' }}>
          {t('advanced.pc.patternsHelp')}
        </span>

        {/* Existing policies list */}
        {policies.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
            {policies.map((policy) => (
              <div key={policy.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <code className={s.macroCmd} style={{ flex: 1, margin: 0 }}>{policy.pattern}</code>
                <button
                  className={s.removeCmdBtn}
                  onClick={() => handleDeletePolicy(policy.id)}
                  title={t('common.delete')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add new policy */}
        <div className={s.commandRow}>
          <input
            className={s.fieldInput}
            type="text"
            placeholder={t('advanced.pc.patternPlaceholder')}
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddPolicy(); }}
          />
          <button
            className={s.saveBtn}
            onClick={handleAddPolicy}
            disabled={!newPattern.trim()}
          >
            {t('advanced.common.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
