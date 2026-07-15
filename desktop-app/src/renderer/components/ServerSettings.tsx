import { useTranslation } from 'react-i18next';
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';
import { Select } from './Select';
import type { SelectOption } from './Select';
import { ConfirmDialog } from './ConfirmDialog';

type Server = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  has_sudo_password: boolean;
  default_ssh_key_id: number | null;
  use_ssh_key_for_login: boolean;
  auto_approve_all: boolean;
  created_at: number;
  updated_at: number;
};

type SshKey = {
  id: number;
  name: string;
  public_key: string;
  has_private_key: boolean;
};

type Policy = {
  id: number;
  server_id: number;
  pattern: string;
  auto_approve: boolean;
  created_at: number;
};

type Runbook = {
  id: number;
  title: string;
  commands: string[];
};

export function ServerSettings() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<Server[]>([]);
  const [policies, setPolicies] = useState<Record<number, Policy[]>>({});
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingHasSudoPassword, setEditingHasSudoPassword] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  // Form
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState(22);
  const [formUsername, setFormUsername] = useState('root');
  const [formPassword, setFormPassword] = useState('');
  const [formSudoPassword, setFormSudoPassword] = useState('');
  const [formDefaultKey, setFormDefaultKey] = useState<number | null>(null);
  const [formUseSshKeyForLogin, setFormUseSshKeyForLogin] = useState(false);
  const [formAutoApproveAll, setFormAutoApproveAll] = useState(false);
  const [formSaving, setFormSaving] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setFormName('');
    setFormHost('');
    setFormPort(22);
    setFormUsername('root');
    setFormPassword('');
    setFormSudoPassword('');
    setEditingHasSudoPassword(false);
    setFormDefaultKey(null);
    setFormUseSshKeyForLogin(false);
    setFormAutoApproveAll(false);
  };

  const startEdit = (server: Server) => {
    setEditingId(server.id);
    setFormName(server.name);
    setFormHost(server.host);
    setFormPort(server.port);
    setFormUsername(server.username);
    setFormPassword('');
    setFormSudoPassword('');
    setEditingHasSudoPassword(server.has_sudo_password);
    setFormDefaultKey(server.default_ssh_key_id);
    setFormUseSshKeyForLogin(server.use_ssh_key_for_login);
    setFormAutoApproveAll(server.auto_approve_all);
  };

  const loadServers = async () => {
    try {
      const res = await api.apiFetch<{ servers: Server[] }>('/api/v1/devops/servers');
      setServers(res.servers);
      // Load policies for each server
      const policyMap: Record<number, Policy[]> = {};
      for (const server of res.servers) {
        try {
          const pRes = await api.apiFetch<{ policies: Policy[] }>(`/api/v1/devops/servers/${server.id}/policies`);
          policyMap[server.id] = pRes.policies;
        } catch { policyMap[server.id] = []; }
      }
      setPolicies(policyMap);
      // Load available runbooks
      try {
        const rRes = await api.apiFetch<{ runbooks: Runbook[] }>('/api/v1/devops/runbooks');
        setRunbooks(rRes.runbooks);
      } catch {}
      // Load available SSH keys
      try {
        const kRes = await api.apiFetch<{ keys: SshKey[] }>('/api/v1/devops/ssh-keys');
        setSshKeys(kRes.keys);
      } catch {}
    } catch (err) {
      console.error('Failed to load servers:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadServers(); }, []);

  const handleSave = async () => {
    const trimmedName = formName.trim();
    const trimmedHost = formHost.trim();
    const trimmedUsername = formUsername.trim();

    if (!trimmedName || !trimmedHost || !trimmedUsername) {
      toast.error(t('advanced.server.fillRequired'));
      return;
    }

    if (formUseSshKeyForLogin && !formDefaultKey) {
      toast.error(t('advanced.server.selectKey'));
      return;
    }

    setFormSaving(true);
    try {
      if (editingId !== null) {
        const updates: Record<string, unknown> = {
          name: trimmedName,
          host: trimmedHost,
          port: formPort,
          username: trimmedUsername,
        };
        if (formPassword) updates.password = formPassword;
        if (formSudoPassword) updates.sudo_password = formSudoPassword;
        updates.default_ssh_key_id = formDefaultKey;
        updates.use_ssh_key_for_login = formUseSshKeyForLogin;
        updates.auto_approve_all = formAutoApproveAll;

        await api.apiFetch(`/api/v1/devops/servers/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(updates),
        });
        toast.success(t('advanced.server.updated'));
      } else {
        if (!formPassword && !formDefaultKey) {
          toast.error(t('advanced.server.credentialsRequired'));
          setFormSaving(false);
          return;
        }
        await api.apiFetch('/api/v1/devops/servers', {
          method: 'POST',
          body: JSON.stringify({
            name: trimmedName,
            host: trimmedHost,
            port: formPort,
            username: trimmedUsername,
            password: formPassword || undefined,
            sudo_password: formSudoPassword || undefined,
            default_ssh_key_id: formDefaultKey,
            use_ssh_key_for_login: formUseSshKeyForLogin,
            auto_approve_all: formAutoApproveAll,
          }),
        });
        toast.success(t('advanced.server.added'));
      }
      resetForm();
      loadServers();
    } catch (err: any) {
      toast.error(err?.body?.error || t('advanced.common.saveFailed'));
    } finally {
      setFormSaving(false);
    }
  };

  const handleDeletePolicy = async (serverId: number, policyId: number) => {
    try {
      await api.apiFetch(`/api/v1/devops/policies/${policyId}`, { method: 'DELETE' });
      setPolicies(prev => ({
        ...prev,
        [serverId]: (prev[serverId] || []).filter(p => p.id !== policyId),
      }));
      toast.success(t('advanced.server.policyDeleted'));
    } catch {
      toast.error(t('advanced.server.policyDeleteFailed'));
    }
  };

  const handleAttachRunbook = async (serverId: number, runbookId: number) => {
    try {
      const res = await api.apiFetch<{ ok: boolean; created: number }>(`/api/v1/devops/servers/${serverId}/attach-runbook`, {
        method: 'POST',
        body: JSON.stringify({ runbook_id: runbookId }),
      });
      toast.success(`Привязано: ${res.created} новых политик`);
      // Reload policies for this server
      try {
        const pRes = await api.apiFetch<{ policies: Policy[] }>(`/api/v1/devops/servers/${serverId}/policies`);
        setPolicies(prev => ({ ...prev, [serverId]: pRes.policies }));
      } catch {}
    } catch {
      toast.error(t('advanced.server.runbookLinkFailed'));
    }
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await api.apiFetch(`/api/v1/devops/servers/${id}`, { method: 'DELETE' });
      toast.success(t('advanced.server.deleted'));
      if (editingId === id) resetForm();
      loadServers();
    } catch {
      toast.error(t('advanced.common.deleteFailed'));
    }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const res = await api.apiFetch<{ ok: boolean; error?: string }>(`/api/v1/devops/servers/${id}/test`, {
        method: 'POST',
      });
      if (res.ok) {
        toast.success(t('advanced.server.connectionSuccessful'));
      } else {
        toast.error(`Ошибка: ${res.error || t('advanced.server.unknown')}`);
      }
    } catch (err: any) {
      toast.error(err?.body?.details || t('advanced.server.connectionFailed'));
    } finally {
      setTesting(null);
    }
  };

  if (loading) return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('settings.sections.servers')}</div>

      {/* Form */}
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.common.name')}</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder={t('advanced.server.namePlaceholder')}
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.server.host')}</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formHost}
          onChange={(e) => setFormHost(e.target.value)}
          placeholder="192.168.1.100"
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.server.port')}</label>
        <input
          className={s.fieldInput}
          type="number"
          value={formPort}
          onChange={(e) => setFormPort(Number(e.target.value))}
          min={1}
          max={65535}
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.server.user')}</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formUsername}
          onChange={(e) => setFormUsername(e.target.value)}
          placeholder="root"
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.server.password')} {editingId !== null ? t('advanced.server.leaveBlank') : ''}</label>
        <input
          className={s.fieldInput}
          type="password"
          value={formPassword}
          onChange={(e) => setFormPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.server.sudoPassword')} {editingId !== null ? t('advanced.server.leaveBlank') : t('advanced.common.optional')}</label>
        <input
          className={s.fieldInput}
          type="password"
          value={formSudoPassword}
          onChange={(e) => setFormSudoPassword(e.target.value)}
          placeholder={t('advanced.server.sudoPlaceholder')}
        />
        {editingId !== null && editingHasSudoPassword && (
          <button
            className={s.cancelBtn}
            style={{ alignSelf: 'flex-start', padding: '6px 10px', fontSize: '12px' }}
            type="button"
            onClick={async () => {
              try {
                await api.apiFetch(`/api/v1/devops/servers/${editingId}`, {
                  method: 'PUT',
                  body: JSON.stringify({ sudo_password: '' }),
                });
                setEditingHasSudoPassword(false);
                setFormSudoPassword('');
                toast.success(t('advanced.server.sudoCleared'));
                loadServers();
              } catch (err: any) {
                toast.error(err?.body?.error || t('advanced.server.sudoClearFailed'));
              }
            }}
          >
            {t('advanced.server.clearSudo')}
          </button>
        )}
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.server.defaultKey')}</label>
        {sshKeys.length > 0 ? (
          <Select
            options={[
              { value: '', label: t('advanced.common.notSelected') },
              ...sshKeys.map((key) => ({
                value: String(key.id),
                label: key.name,
                hint: key.has_private_key ? t('advanced.ssh.fullPair') : t('advanced.ssh.publicOnly'),
              })),
            ]}
            value={formDefaultKey != null ? String(formDefaultKey) : ''}
            onChange={(v) => {
              setFormDefaultKey(v ? Number(v) : null);
              if (!v) setFormUseSshKeyForLogin(false);
            }}
            placeholder={t('advanced.common.notSelected')}
          />
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {t('advanced.server.addKeysFirst')}
          </div>
        )}
      </div>

      <div className={s.fieldGroup}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input
            className={s.macroCheckbox}
            type="checkbox"
            checked={formUseSshKeyForLogin}
            onChange={(e) => setFormUseSshKeyForLogin(e.target.checked)}
            disabled={!formDefaultKey}
          />
          {t('advanced.server.useKeyLogin')}
        </label>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {t('advanced.server.useKeyHelp')}
        </div>
      </div>

      <div className={s.fieldGroup}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input
            className={s.macroCheckbox}
            type="checkbox"
            checked={formAutoApproveAll}
            onChange={(e) => setFormAutoApproveAll(e.target.checked)}
          />
          {t('advanced.server.autoApprove')}
        </label>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {t('advanced.server.dangerousBlocked')}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className={s.saveBtn}
          onClick={handleSave}
          disabled={formSaving}
        >
          {formSaving ? t('common.saving') : editingId ? t('advanced.common.update') : t('advanced.common.add')}
        </button>
        {editingId !== null && (
          <button className={s.cancelBtn} onClick={resetForm}>
            {t('common.cancel')}
          </button>
        )}
      </div>

      {/* Server list */}
      {servers.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>{t('advanced.server.addedServers')}</div>
          {servers.map((server) => (
            <div key={server.id} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>{server.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {server.username}@{server.host}:{server.port}
                  {server.has_password && t('advanced.server.passwordSuffix')}
                  {server.default_ssh_key_id && t('advanced.server.keySuffix')}
                  {server.use_ssh_key_for_login && t('advanced.server.sshLoginSuffix')}
                  {server.has_sudo_password && ' · sudo'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  className={s.macroActionBtn}
                  onClick={() => handleTest(server.id)}
                  disabled={testing === server.id}
                  title={t('advanced.server.testConnection')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </button>
                <button
                  className={s.macroActionBtn}
                  onClick={() => startEdit(server)}
                  title={t('common.edit')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                  onClick={() => setDeleteConfirmId(server.id)}
                  title={t('common.delete')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
              {/* Policies */}
              {policies[server.id] && policies[server.id].length > 0 && (
                <div style={{ marginTop: '8px', borderTop: '1px solid var(--border-light)', paddingTop: '8px' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t('advanced.server.autoAllowed')}</div>
                  {policies[server.id].map((policy) => (
                    <div key={policy.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                      <code style={{ fontSize: '10px', color: 'var(--accent)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {policy.pattern}
                      </code>
                      <button
                        className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                        style={{ width: '20px', height: '20px' }}
                        onClick={() => handleDeletePolicy(server.id, policy.id)}
                        title={t('advanced.server.deletePolicy')}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* Attach runbook */}
              {runbooks.length > 0 && (
                <div style={{ marginTop: '8px', borderTop: '1px solid var(--border-light)', paddingTop: '8px' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t('advanced.server.linkRunbook')}</div>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {runbooks.map((rb) => (
                      <button
                        key={rb.id}
                        className={s.cancelBtn}
                        style={{ fontSize: '10px', padding: '3px 8px' }}
                        onClick={() => handleAttachRunbook(server.id, rb.id)}
                        title={t('advanced.server.commandsTitle', { count: rb.commands.length, preview: rb.commands.slice(0, 3).join(', ') })}
                      >
                        {rb.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={t('advanced.server.deleteTitle')}
        text={t('advanced.server.deleteMessage')}
        onCancel={() => setDeleteConfirmId(null)}
        onConfirm={() => handleDelete(deleteConfirmId!)}
      />
    </div>
  );
}
