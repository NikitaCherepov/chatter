import { useTranslation } from 'react-i18next';
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';
import { ConfirmDialog } from './ConfirmDialog';

type SshKey = {
  id: number;
  name: string;
  public_key: string;
  has_private_key: boolean;
  created_at: number;
  updated_at: number;
};

export function SshKeySettings() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [formName, setFormName] = useState('');
  const [formPublicKey, setFormPublicKey] = useState('');
  const [formPrivateKey, setFormPrivateKey] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  const loadKeys = async () => {
    try {
      const res = await api.apiFetch<{ keys: SshKey[] }>('/api/v1/devops/ssh-keys');
      setKeys(res.keys);
    } catch (err) {
      console.error('Failed to load SSH keys:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadKeys(); }, []);

  const resetForm = () => {
    setFormName('');
    setFormPublicKey('');
    setFormPrivateKey('');
  };

  const handleSave = async () => {
    const trimmedName = formName.trim();
    const trimmedKey = formPublicKey.trim();

    if (!trimmedName || !trimmedKey) {
      toast.error(t('advanced.ssh.fillRequired'));
      return;
    }

    setFormSaving(true);
    try {
      await api.apiFetch('/api/v1/devops/ssh-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmedName,
          public_key: trimmedKey,
          private_key: formPrivateKey.trim() || undefined,
        }),
      });
      toast.success(t('advanced.ssh.added'));
      resetForm();
      loadKeys();
    } catch (err: any) {
      toast.error(err?.body?.error || t('advanced.common.saveFailed'));
    } finally {
      setFormSaving(false);
    }
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await api.apiFetch(`/api/v1/devops/ssh-keys/${id}`, { method: 'DELETE' });
      toast.success(t('advanced.ssh.deleted'));
      loadKeys();
    } catch {
      toast.error(t('advanced.common.deleteFailed'));
    }
  };

  const [importing, setImporting] = useState(false);
  const [detectedKeys, setDetectedKeys] = useState<{ name: string; filename: string; publicKey?: string; privateKey?: string }[]>([]);
  const [showImport, setShowImport] = useState(false);

  const handleDetectKeys = async () => {
    if (!window.electronAPI?.readSshKeys) {
      toast.error(t('advanced.ssh.desktopOnly'));
      return;
    }
    setImporting(true);
    try {
      const found = await window.electronAPI.readSshKeys();
      if (found.length === 0) {
        toast.info(t('advanced.ssh.notFound'));
      } else {
        setDetectedKeys(found);
        setShowImport(true);
      }
    } catch (err: any) {
      toast.error(err?.message === 'no_ssh_dir' ? t('advanced.ssh.folderNotFound') : t('advanced.ssh.readFailed'));
    } finally {
      setImporting(false);
    }
  };

  const handleImportKey = async (key: typeof detectedKeys[0]) => {
    if (!key.publicKey && !key.privateKey) return;
    const name = key.filename; // e.g. "id_ed25519"
    setFormSaving(true);
    try {
      await api.apiFetch('/api/v1/devops/ssh-keys', {
        method: 'POST',
        body: JSON.stringify({
          name,
          public_key: key.publicKey || '',
          private_key: key.privateKey || undefined,
        }),
      });
      toast.success(`Ключ ${name} импортирован`);
      loadKeys();
      // Remove from detected list
      setDetectedKeys(prev => prev.filter(k => k.filename !== key.filename));
      if (detectedKeys.length <= 1) setShowImport(false);
    } catch (err: any) {
      toast.error(err?.body?.error || t('advanced.ssh.importFailed'));
    } finally {
      setFormSaving(false);
    }
  };

  if (loading) return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('settings.sections.sshkeys')}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
        {t('advanced.ssh.help')}
      </div>

      {/* Form */}
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.common.name')}</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder={t('advanced.ssh.namePlaceholder')}
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.ssh.publicKey')}</label>
        <textarea
          className={s.textareaInput}
          value={formPublicKey}
          onChange={(e) => setFormPublicKey(e.target.value)}
          placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... user@host"
          rows={3}
          style={{ minHeight: '60px', fontFamily: 'monospace', fontSize: '11px' }}
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>{t('advanced.ssh.privateKey')}</label>
        <textarea
          className={s.textareaInput}
          value={formPrivateKey}
          onChange={(e) => setFormPrivateKey(e.target.value)}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          rows={3}
          style={{ minHeight: '60px', fontFamily: 'monospace', fontSize: '11px' }}
        />
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className={s.saveBtn}
          onClick={handleSave}
          disabled={formSaving}
        >
          {formSaving ? t('common.saving') : t('advanced.common.add')}
        </button>
        {typeof window.electronAPI?.readSshKeys === 'function' && (
          <button
            className={s.cancelBtn}
            onClick={handleDetectKeys}
            disabled={importing}
          >
            {importing ? t('common.searchPlaceholder') : t('advanced.ssh.import')}
          </button>
        )}
      </div>

      {/* Detected keys */}
      {showImport && detectedKeys.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>{t('advanced.ssh.found')}</div>
          {detectedKeys.map((key) => (
            <div key={key.filename} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>
                  {key.filename}
                  {key.publicKey && key.privateKey && <span style={{ color: 'var(--accent)', marginLeft: '6px', fontSize: '10px' }}>{t('advanced.ssh.pair')}</span>}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {key.publicKey ? 'pub + ' : ''}{key.privateKey ? 'private' : ''}
                </div>
              </div>
              <button
                className={s.saveBtn}
                style={{ fontSize: '11px', padding: '4px 10px' }}
                onClick={() => handleImportKey(key)}
              >
                {t('common.save')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Key list */}
      {keys.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>{t('advanced.ssh.savedKeys')}</div>
          {keys.map((key) => (
            <div key={key.id} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>
                  {key.name}
                  {key.has_private_key && <span style={{ color: 'var(--accent)', marginLeft: '6px', fontSize: '10px' }}>{t('advanced.ssh.pair')}</span>}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {key.public_key.substring(0, 60)}...
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                  onClick={() => setDeleteConfirmId(key.id)}
                  title={t('common.delete')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={t('advanced.ssh.deleteTitle')}
        text={t('advanced.ssh.deleteMessage')}
        onCancel={() => setDeleteConfirmId(null)}
        onConfirm={() => handleDelete(deleteConfirmId!)}
      />
    </div>
  );
}
