import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { Icon } from './Icon';
import { ConfirmDialog } from './ConfirmDialog';
import shared from './SettingsModal.module.scss';
import rows from './RestrictionsSettings.module.scss';
import toggle from './MemoryPopover.module.scss';
import s from './PCSettings.module.scss';

type PcSettings = { fs_scan_enabled: boolean; auto_approve_all: boolean; file_read_enabled: boolean };
type PcPolicy = { id: number; pattern: string; auto_approve: boolean; created_at: number };
const base = '/api/v1/pc-commands';
const exactPattern = (value: string) => `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

export function PCSettings() {
  const { t } = useTranslation();
  const id = useId();
  const copy = (key: string) => t(`advanced.pc.layout.${key}`);
  const [settings, setSettings] = useState<PcSettings>({ fs_scan_enabled: false, auto_approve_all: false, file_read_enabled: true });
  const [policies, setPolicies] = useState<PcPolicy[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [mode, setMode] = useState<'exact' | 'regex'>('exact');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmAutoApprove, setConfirmAutoApprove] = useState(false);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const [value, result] = await Promise.all([api.apiFetch<PcSettings>(`${base}/settings`), api.apiFetch<{ policies: PcPolicy[] }>(`${base}/policies`)]);
      setSettings(value); setPolicies(result.policies || []);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mutate = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await action(); }
    catch (error) { toast.error(api.getApiErrorMessage(error, copy('saveFailed'))); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const update = (key: keyof PcSettings) => void mutate(async () => {
    const previous = settings[key];
    setSettings(current => ({ ...current, [key]: !previous }));
    try { await api.apiFetch(`${base}/settings`, { method: 'PUT', body: JSON.stringify({ [key]: !previous }) }); }
    catch (error) { setSettings(current => ({ ...current, [key]: previous })); throw error; }
  });
  const add = () => {
    const input = newPattern.trim();
    if (!input || settings.auto_approve_all) return;
    const pattern = mode === 'exact' ? exactPattern(input) : input;
    try { new RegExp(pattern); } catch { toast.error(copy('invalidRegex')); return; }
    if (policies.some(policy => policy.pattern === pattern && policy.auto_approve)) { toast.info(copy('duplicate')); return; }
    void mutate(async () => {
      const result = await api.apiFetch<{ id: number }>(`${base}/policies`, { method: 'POST', body: JSON.stringify({ pattern }) });
      setPolicies(current => [...current, { id: result.id, pattern, auto_approve: true, created_at: Math.floor(Date.now() / 1000) }]);
      setNewPattern('');
    });
  };
  const remove = (policyId: number) => void mutate(async () => {
    await api.apiFetch(`${base}/policies/${policyId}`, { method: 'DELETE' });
    setPolicies(current => current.filter(policy => policy.id !== policyId));
  });
  const row = (key: keyof PcSettings, icon: string, title: string, hint: string) => {
    const labelId = `${id}-${key}`;
    return <div className={rows.row}>
      <span className={rows.icon}><Icon name={icon} size={18} /></span>
      <div className={rows.text}><span className={rows.label} id={labelId}>{copy(title)}</span><p id={`${labelId}-hint`}>{copy(hint)}</p></div>
      <button type="button" role="switch" aria-checked={settings[key]} aria-labelledby={labelId} aria-describedby={`${labelId}-hint`} disabled={busy}
        onClick={() => {
          if (key === 'auto_approve_all' && !settings.auto_approve_all) setConfirmAutoApprove(true);
          else update(key);
        }} className={`${toggle.toggle} ${settings[key] ? toggle.toggleActive : ''}`}><span /></button>
    </div>;
  };
  return <div className={shared.panel}>
    <div className={shared.panelTitle}>{t('settings.sections.pc')}</div>
    <p className={rows.intro}>{copy('intro')}</p>
    {loading ? <div role="status">{t('common.loading')}</div> : failed ? <div role="alert" className={rows.error}><p>{copy('loadFailed')}</p><button type="button" className={shared.cancelBtn} onClick={() => void load()}>{copy('retry')}</button></div> : <>
      <section className={rows.group}><h3>{copy('files')}</h3>
        {row('fs_scan_enabled', 'database', 'browse', 'browseHelp')}
        {row('file_read_enabled', 'file', 'read', 'readHelp')}
      </section>
      <section className={rows.group}><h3>{copy('execution')}</h3>
        {row('auto_approve_all', 'terminal', 'auto', 'autoHelp')}
      </section>
      <section className={s.exceptions} aria-labelledby={`${id}-exceptions`}>
        <div className={s.heading}><h3 id={`${id}-exceptions`}>{copy('exceptions')}</h3><span>{policies.length}</span></div>
        <p className={s.hint}>{copy('exceptionsHelp')}</p>
        {settings.auto_approve_all && <p className={s.notice} role="status">{copy('allApproved')}</p>}
        {policies.length ? <ul className={s.list}>{policies.map(policy => <li key={policy.id}>
          <Icon name="code" size={16} /><code>{policy.pattern}</code>
          <button type="button" className={shared.removeCmdBtn} disabled={busy} onClick={() => remove(policy.id)} aria-label={`${t('common.delete')}: ${policy.pattern}`} title={t('common.delete')}>×</button>
        </li>)}</ul> : <p className={s.empty}>{copy('empty')}</p>}
        <fieldset className={s.form} disabled={busy || settings.auto_approve_all}>
          <div className={s.modes} aria-label={copy('matchMode')}>{(['exact', 'regex'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{copy(value)}</button>)}</div>
          <form onSubmit={event => { event.preventDefault(); add(); }}>
            <input aria-label={copy(mode === 'exact' ? 'command' : 'pattern')} className={shared.fieldInput} placeholder={copy(mode === 'exact' ? 'commandPlaceholder' : 'regexPlaceholder')} value={newPattern} onChange={event => setNewPattern(event.target.value)} />
            <button type="submit" className={shared.saveBtn} disabled={!newPattern.trim()}>{t('advanced.common.add')}</button>
          </form>
          <p className={s.hint}>{copy(mode === 'exact' ? 'exactHelp' : 'regexHelp')}</p>
        </fieldset>
      </section>
    </>}
    {confirmAutoApprove && <ConfirmDialog open
      title={copy('confirmAutoTitle')} text={copy('confirmAutoHelp')}
      confirmLabel={copy('confirmAutoEnable')} confirmTone="primary"
      onCancel={() => setConfirmAutoApprove(false)}
      onConfirm={() => { setConfirmAutoApprove(false); if (!settings.auto_approve_all) update('auto_approve_all'); }} />}
  </div>;
}
