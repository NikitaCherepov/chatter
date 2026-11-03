import { RUNBOOK_COMMAND_TOOLS_ENABLED } from '../lib/runbook-ui';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { normalizeSettingsSearch } from '../lib/settings-navigation';
import { Icon } from './Icon';
import { Select } from './Select';
import { ConfirmDialog } from './ConfirmDialog';
import shared from './SettingsModal.module.scss';
import catalog from './MacroSettings.module.scss';
import rows from './RestrictionsSettings.module.scss';
import toggle from './MemoryPopover.module.scss';
import s from './ServerSettings.module.scss';

type Server = { id: number; name: string; host: string; port: number; username: string; has_password: boolean; has_sudo_password: boolean; default_ssh_key_id: number | null; use_ssh_key_for_login: boolean; auto_approve_all: boolean; created_at: number; updated_at: number };
type SshKey = { id: number; name: string; public_key: string; has_private_key: boolean };
type Policy = { id: number; server_id: number; pattern: string; auto_approve: boolean; created_at: number };
type Runbook = { id: number; title: string; commands: string[] };
type Draft = { name: string; host: string; port: string; username: string; password: string; sudoPassword: string; keyId: number | null; keyLogin: boolean; autoApprove: boolean; clearSudo: boolean };
const emptyDraft = (): Draft => ({ name: '', host: '', port: '22', username: 'root', password: '', sudoPassword: '', keyId: null, keyLogin: false, autoApprove: false, clearSudo: false });
const draftFor = (server: Server): Draft => ({ ...emptyDraft(), name: server.name, host: server.host, port: String(server.port), username: server.username, keyId: server.default_ssh_key_id, keyLogin: server.use_ssh_key_for_login, autoApprove: server.auto_approve_all });
const payloadFor = (draft: Draft) => ({
  name: draft.name.trim(), host: draft.host.trim(), port: Number(draft.port), username: draft.username.trim(),
  default_ssh_key_id: draft.keyId, use_ssh_key_for_login: draft.keyLogin, auto_approve_all: draft.autoApprove,
  ...(draft.password ? { password: draft.password } : {}),
  ...(draft.clearSudo ? { sudo_password: '' } : draft.sudoPassword ? { sudo_password: draft.sudoPassword } : {}),
});
const base = '/api/v1/devops/servers';

export function ServerSettings() {
  const { t } = useTranslation();
  const copy = (key: string) => t(`advanced.server.layout.${key}`);
  const id = useId();
  const [servers, setServers] = useState<Server[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [keysFailed, setKeysFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'read' | 'edit' | 'new'>('read');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [original, setOriginal] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'auto' | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; message: string } | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [policiesFailed, setPoliciesFailed] = useState(false);
  const [policyRevision, setPolicyRevision] = useState(0);
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const detailRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const selected = servers.find(server => server.id === selectedId) ?? servers[0];
  const editing = view !== 'read';
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(original);
  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const result = await api.apiFetch<{ servers: Server[] }>(base);
      setServers(result.servers);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, []);
  const loadKeys = useCallback(async () => {
    try { const result = await api.apiFetch<{ keys: SshKey[] }>('/api/v1/devops/ssh-keys'); setSshKeys(result.keys); setKeysFailed(false); }
    catch { setKeysFailed(true); }
  }, []);
  useEffect(() => { void load(); void loadKeys();
    if (RUNBOOK_COMMAND_TOOLS_ENABLED) void api.apiFetch<{ runbooks: Runbook[] }>('/api/v1/devops/runbooks').then(result => setRunbooks(result.runbooks)).catch(() => {});
  }, [load, loadKeys]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setPoliciesLoading(true); setPoliciesFailed(false); setPolicies([]);
    api.apiFetch<{ policies: Policy[] }>(`${base}/${selected.id}/policies`)
      .then(result => { if (!cancelled) setPolicies(result.policies); })
      .catch(() => { if (!cancelled) setPoliciesFailed(true); })
      .finally(() => { if (!cancelled) setPoliciesLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.id, policyRevision]);
  useEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selected?.id, view]);
  const mutate = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await action(); }
    catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.common.saveFailed'))); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const request = (action: () => void) => { if (inFlight.current) return; if (dirty) setPending(() => action); else action(); };
  const create = () => request(() => { const next = emptyDraft(); setDraft(next); setOriginal(next); setView('new'); });
  const edit = () => { if (!selected || busy) return; const next = draftFor(selected); setDraft(next); setOriginal(next); setView('edit'); };
  const save = () => {
    if (!dirty || !draft.name.trim() || !draft.host.trim() || !draft.username.trim()) return;
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { toast.error(copy('invalidPort')); return; }
    if (draft.keyLogin && !draft.keyId) { toast.error(t('advanced.server.selectKey')); return; }
    if (view === 'new' && !draft.password && !draft.keyId) { toast.error(t('advanced.server.credentialsRequired')); return; }
    void mutate(async () => {
      const value = payloadFor(draft);
      const now = Math.floor(Date.now() / 1000);
      const existing = view === 'edit' ? selected : undefined;
      const result = await api.apiFetch<{ id?: number }>(existing ? `${base}/${existing.id}` : base, { method: existing ? 'PUT' : 'POST', body: JSON.stringify(value) });
      const server: Server = { id: existing ? existing.id : result.id!, name: value.name, host: value.host, port, username: value.username,
        default_ssh_key_id: draft.keyId, use_ssh_key_for_login: draft.keyLogin, auto_approve_all: draft.autoApprove,
        has_password: Boolean(draft.password || existing?.has_password), has_sudo_password: draft.clearSudo ? false : Boolean(draft.sudoPassword || existing?.has_sudo_password),
        created_at: existing?.created_at ?? now, updated_at: now };
      setServers(current => existing ? current.map(item => item.id === server.id ? server : item) : [...current, server]);
      setSelectedId(server.id); setQuery(''); setView('read'); setDraft(emptyDraft()); setOriginal(emptyDraft()); setTestResult(null);
      toast.success(t(existing ? 'advanced.server.updated' : 'advanced.server.added'));
    });
  };
  const remove = () => { if (!selected) return; void mutate(async () => {
    await api.apiFetch(`${base}/${selected.id}`, { method: 'DELETE' });
    setServers(current => current.filter(server => server.id !== selected.id)); setSelectedId(null); setConfirm(null);
    toast.success(t('advanced.server.deleted'));
  }); };
  const test = () => { if (!selected) return; void mutate(async () => {
    setTestResult(null);
    try {
      const result = await api.apiFetch<{ ok: boolean; error?: string }>(`${base}/${selected.id}/test`, { method: 'POST' });
      setTestResult({ id: selected.id, ok: result.ok, message: result.ok ? t('advanced.server.connectionSuccessful') : result.error || t('advanced.server.connectionFailed') });
    } catch (error) { setTestResult({ id: selected.id, ok: false, message: api.getApiErrorMessage(error, t('advanced.server.connectionFailed')) }); }
  }); };
  const deletePolicy = (policy: Policy) => void mutate(async () => {
    await api.apiFetch(`/api/v1/devops/policies/${policy.id}`, { method: 'DELETE' });
    setPolicies(current => current.filter(item => item.id !== policy.id)); toast.success(t('advanced.server.policyDeleted'));
  });
  const attachRunbook = (runbookId: number) => { if (!selected) return; void mutate(async () => {
    await api.apiFetch(`${base}/${selected.id}/attach-runbook`, { method: 'POST', body: JSON.stringify({ runbook_id: runbookId }) });
    setPolicyRevision(value => value + 1);
  }); };
  const visible = servers.filter(server => normalizeSettingsSearch(`${server.name} ${server.host} ${server.username}`).includes(normalizeSettingsSearch(query)));
  const switchRow = (key: 'keyLogin' | 'autoApprove', icon: string, title: string, hint: string, disabled = false) => <div className={rows.row}>
    <span className={rows.icon}><Icon name={icon} size={18} /></span><div className={rows.text}><span className={rows.label} id={`${id}-${key}`}>{title}</span><p id={`${id}-${key}-hint`}>{hint}</p></div>
    <button type="button" role="switch" disabled={busy || disabled} aria-checked={draft[key]} aria-labelledby={`${id}-${key}`} aria-describedby={`${id}-${key}-hint`}
      onClick={() => key === 'autoApprove' && !draft.autoApprove ? setConfirm('auto') : setField(key, !draft[key])}
      className={`${toggle.toggle} ${draft[key] ? toggle.toggleActive : ''}`}><span /></button>
  </div>;
  return <div className={`${shared.panel} ${s.panel}`}>
    <div className={shared.panelTitle}>{t('settings.sections.servers')}</div><p className={s.intro}>{copy('intro')}</p>
    {loading ? <div role="status">{t('common.loading')}</div> : failed ? <div role="alert"><p>{copy('loadFailed')}</p><button type="button" className={shared.cancelBtn} onClick={() => void load()}>{copy('retry')}</button></div> :
    <div className={s.workspace}>
      <aside className={s.catalog} aria-label={t('advanced.server.addedServers')}>
        <input type="search" className={shared.fieldInput} value={query} onChange={event => setQuery(event.target.value)} placeholder={copy('search')} aria-label={copy('search')} />
        <button type="button" className={shared.saveBtn} disabled={busy} onClick={create}>+ {copy('add')}</button>
        <div className={s.list}>{visible.map(server => <button type="button" key={server.id} className={`${catalog.item} ${selected?.id === server.id && view !== 'new' ? catalog.active : ''}`} aria-pressed={selected?.id === server.id && view !== 'new'} disabled={busy}
          onClick={() => request(() => { setSelectedId(server.id); setView('read'); })}>
          <Icon name="server" size={17} /><span><strong title={server.name}>{server.name}</strong><span className={`${catalog.meta} ${s.address}`} title={`${server.username}@${server.host}:${server.port}`}>{server.username}@{server.host}:{server.port}</span></span>
        </button>)}{!visible.length && <p className={catalog.empty}>{query ? t('common.nothingFound') : copy('emptyList')}</p>}</div>
        <span className={catalog.count}>{visible.length} / {servers.length}</span>
      </aside>
      <div className={s.detail} ref={detailRef}>
        {editing ? <>
          <h3 className={catalog.title}>{copy(view === 'new' ? 'add' : 'edit')}</h3>
          <fieldset className={s.form} disabled={busy}>
            <h4 className={s.sectionTitle}>{copy('connection')}</h4>
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.common.name')}</span><input className={shared.fieldInput} value={draft.name} onChange={event => setField('name', event.target.value)} placeholder={t('advanced.server.namePlaceholder')} /></label>
            <div className={s.hostRow}>
              <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.server.host')}</span><input className={shared.fieldInput} value={draft.host} onChange={event => setField('host', event.target.value)} placeholder="example.com" /></label>
              <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.server.port')}</span><input type="number" min={1} max={65535} className={shared.fieldInput} value={draft.port} onChange={event => setField('port', event.target.value)} /></label>
            </div>
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.server.user')}</span><input className={shared.fieldInput} value={draft.username} onChange={event => setField('username', event.target.value)} autoComplete="off" /></label>
            <h4 className={s.sectionTitle}>{copy('authentication')}</h4>
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.server.password')}</span><input type="password" autoComplete="new-password" className={shared.fieldInput} value={draft.password} onChange={event => setField('password', event.target.value)} placeholder={view === 'edit' && selected?.has_password ? copy('keepPassword') : copy('passwordPlaceholder')} /></label>
            <p className={s.hint}>{copy(view === 'edit' ? 'keepSecrets' : 'credentialsHelp')}</p>
            <div className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.server.defaultKey')}</span>
              <Select disabled={busy || keysFailed} value={draft.keyId === null ? '' : String(draft.keyId)} options={[
                { value: '', label: t('advanced.common.notSelected') },
                ...sshKeys.map(key => ({ value: String(key.id), label: key.name, hint: t(key.has_private_key ? 'advanced.ssh.fullPair' : 'advanced.ssh.publicOnly') })),
                ...(draft.keyId && !sshKeys.some(key => key.id === draft.keyId) ? [{ value: String(draft.keyId), label: copy('savedKey') }] : []),
              ]} onChange={value => setDraft(current => ({ ...current, keyId: value ? Number(value) : null, keyLogin: value ? current.keyLogin : false }))} />
              {!keysFailed && !sshKeys.length && <p className={s.hint}>{t('advanced.server.addKeysFirst')}</p>}
              {keysFailed && <div role="alert"><p className={s.hint}>{copy('keysFailed')}</p><button type="button" className={shared.cancelBtn} onClick={() => void loadKeys()}>{copy('retry')}</button></div>}
            </div>
            {switchRow('keyLogin', 'key', t('advanced.server.useKeyLogin'), copy('keyHelp'), !draft.keyId)}
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.server.sudoPassword')} {t('advanced.common.optional')}</span><input type="password" autoComplete="new-password" disabled={busy || draft.clearSudo} className={shared.fieldInput} value={draft.sudoPassword} onChange={event => setField('sudoPassword', event.target.value)} placeholder={view === 'edit' && selected?.has_sudo_password ? copy('keepPassword') : t('advanced.server.sudoPlaceholder')} /></label>
            {view === 'edit' && selected?.has_sudo_password && <button type="button" className={s.textButton} onClick={() => setDraft(current => ({ ...current, clearSudo: !current.clearSudo, sudoPassword: '' }))}>{draft.clearSudo ? copy('undoClear') : copy('clearSudo')}</button>}
            {draft.clearSudo && <p className={s.hint}>{copy('clearOnSave')}</p>}
            <h4 className={s.sectionTitle}>{copy('permissions')}</h4>
            {switchRow('autoApprove', 'terminal', t('advanced.server.autoApprove'), t('advanced.server.dangerousBlocked'))}
          </fieldset>
          <div className={catalog.actions}><button type="button" className={shared.saveBtn} disabled={busy || !dirty || !draft.name.trim() || !draft.host.trim() || !draft.username.trim()} onClick={save}>{busy ? t('common.saving') : t('common.save')}</button><button type="button" className={shared.cancelBtn} disabled={busy} onClick={() => request(() => { setView('read'); setDraft(emptyDraft()); setOriginal(emptyDraft()); })}>{t('common.cancel')}</button></div>
        </> : selected ? <>
          <div className={s.serverHeading}><span className={s.serverIcon}><Icon name="server" size={24} /></span><div><h3 className={catalog.title}>{selected.name}</h3><p className={s.connectionAddress}>{selected.username}@{selected.host}:{selected.port}</p></div></div>
          <div className={catalog.actions}><button type="button" className={shared.saveBtn} disabled={busy} onClick={test}>{busy ? copy('working') : t('advanced.server.testConnection')}</button><button type="button" className={shared.cancelBtn} disabled={busy} onClick={edit}>{t('common.edit')}</button></div>
          <p className={s.hint}>{copy('testHelp')}</p>
          {testResult?.id === selected.id && <p role="status" className={`${s.testResult} ${testResult.ok ? s.success : ''}`}>{testResult.message}</p>}
          <h4 className={s.sectionTitle}>{copy('connection')}</h4>
          <dl className={s.facts}>
            <div><dt>{t('advanced.server.host')}</dt><dd>{selected.host}</dd></div>
            <div><dt>{t('advanced.server.port')}</dt><dd>{selected.port}</dd></div>
            <div><dt>{t('advanced.server.user')}</dt><dd>{selected.username}</dd></div>
            <div><dt>{copy('loginMethod')}</dt><dd>{copy(selected.use_ssh_key_for_login ? 'sshLogin' : 'passwordLogin')}</dd></div>
            <div><dt>{t('advanced.server.defaultKey')}</dt><dd>{selected.default_ssh_key_id ? sshKeys.find(key => key.id === selected.default_ssh_key_id)?.name || copy('savedKey') : t('advanced.common.notSelected')}</dd></div>
            <div><dt>{copy('sudo')}</dt><dd>{copy(selected.has_sudo_password ? 'configured' : 'notConfigured')}</dd></div>
          </dl>
          <h4 className={s.sectionTitle}>{copy('permissions')}</h4><p className={s.permission}><Icon name="shield" size={17} />{copy(selected.auto_approve_all ? 'automatic' : 'ask')}</p>
          <h4 className={s.sectionTitle}>{t('advanced.pc.layout.exceptions')}</h4>
          <p className={s.hint}>{copy('policiesHelp')}</p>
          {selected.auto_approve_all && <p className={s.hint}>{copy('allApproved')}</p>}
          {policiesLoading ? <p className={s.hint} role="status">{t('common.loading')}</p> : policiesFailed ? <div role="alert"><p className={s.hint}>{copy('policiesFailed')}</p><button type="button" className={shared.cancelBtn} onClick={() => setPolicyRevision(value => value + 1)}>{copy('retry')}</button></div> : policies.length ? <ul className={s.policyList}>{policies.map(policy => <li key={policy.id}><code>{policy.pattern}</code><button type="button" className={shared.removeCmdBtn} disabled={busy} title={t('advanced.server.deletePolicy')} aria-label={`${t('advanced.server.deletePolicy')}: ${policy.pattern}`} onClick={() => deletePolicy(policy)}>×</button></li>)}</ul> : <p className={s.hint}>{copy('noPolicies')}</p>}
          {RUNBOOK_COMMAND_TOOLS_ENABLED && runbooks.length > 0 && <section><h4 className={s.sectionTitle}>{t('advanced.server.linkRunbook')}</h4><div className={catalog.actions}>{runbooks.map(runbook => <button type="button" className={shared.cancelBtn} key={runbook.id} disabled={busy} onClick={() => attachRunbook(runbook.id)}>{runbook.title}</button>)}</div></section>}
          <div className={s.deleteArea}><button type="button" disabled={busy} onClick={() => setConfirm('delete')}>{t('common.delete')}</button></div>
        </> : <div className={s.empty}><Icon name="server" size={30} /><h3>{copy('emptyTitle')}</h3><p>{copy('emptyHelp')}</p><button type="button" className={shared.saveBtn} onClick={create}>+ {copy('add')}</button></div>}
      </div>
    </div>}
    {pending && <ConfirmDialog open title={copy('discardTitle')} text={copy('discardHelp')} confirmLabel={copy('discard')} confirmTone="primary" onCancel={() => setPending(null)} onConfirm={() => { const action = pending; setPending(null); action(); }} />}
    {confirm && <ConfirmDialog open title={confirm === 'delete' ? t('advanced.server.deleteTitle') : copy('autoTitle')} text={confirm === 'delete' ? t('advanced.server.deleteMessage') : copy('autoHelp')} confirmLabel={confirm === 'delete' ? t('common.delete') : copy('enable')} confirmTone={confirm === 'delete' ? 'danger' : 'primary'} confirmDisabled={busy} onCancel={() => { if (!busy) setConfirm(null); }} onConfirm={() => { if (confirm === 'delete') remove(); else { setField('autoApprove', true); setConfirm(null); } }} />}
  </div>;
}