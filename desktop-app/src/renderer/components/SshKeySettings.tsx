import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';

type SshKey = {
  id: number;
  name: string;
  public_key: string;
  has_private_key: boolean;
  created_at: number;
  updated_at: number;
};

export function SshKeySettings() {
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
      toast.error('Заполните название и публичный ключ');
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
      toast.success('SSH-ключ добавлен');
      resetForm();
      loadKeys();
    } catch (err: any) {
      toast.error(err?.body?.error || 'Ошибка сохранения');
    } finally {
      setFormSaving(false);
    }
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await api.apiFetch(`/api/v1/devops/ssh-keys/${id}`, { method: 'DELETE' });
      toast.success('SSH-ключ удалён');
      loadKeys();
    } catch {
      toast.error('Ошибка удаления');
    }
  };

  const [importing, setImporting] = useState(false);
  const [detectedKeys, setDetectedKeys] = useState<{ name: string; filename: string; publicKey?: string; privateKey?: string }[]>([]);
  const [showImport, setShowImport] = useState(false);

  const handleDetectKeys = async () => {
    if (!window.electronAPI?.readSshKeys) {
      toast.error('Доступно только в десктоп-приложении');
      return;
    }
    setImporting(true);
    try {
      const found = await window.electronAPI.readSshKeys();
      if (found.length === 0) {
        toast.info('В ~/.ssh/ не найдены ключи (id_ed25519, id_rsa и т.д.)');
      } else {
        setDetectedKeys(found);
        setShowImport(true);
      }
    } catch (err: any) {
      toast.error(err?.message === 'no_ssh_dir' ? 'Папка ~/.ssh/ не найдена' : 'Ошибка чтения ключей');
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
      toast.error(err?.body?.error || 'Ошибка импорта');
    } finally {
      setFormSaving(false);
    }
  };

  if (loading) return <div className={s.panel}><div className={s.promptLoading}>Загрузка...</div></div>;

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>SSH-ключи</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
        SSH-ключи для установки на серверы. Публичный ключ устанавливается в authorized_keys, приватный — опционально для входа. В настройках сервера можно выбрать ключ по умолчанию.
      </div>

      {/* Form */}
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Название</label>
        <input
          className={s.fieldInput}
          type="text"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="Название ключа"
        />
      </div>

      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>Публичный ключ</label>
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
        <label className={s.fieldLabel}>Приватный ключ (опционально)</label>
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
          {formSaving ? 'Сохранение...' : 'Добавить'}
        </button>
        {typeof window.electronAPI?.readSshKeys === 'function' && (
          <button
            className={s.cancelBtn}
            onClick={handleDetectKeys}
            disabled={importing}
          >
            {importing ? 'Поиск...' : 'Импорт из ~/.ssh'}
          </button>
        )}
      </div>

      {/* Detected keys */}
      {showImport && detectedKeys.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>Найдены ключи в ~/.ssh</div>
          {detectedKeys.map((key) => (
            <div key={key.filename} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>
                  {key.filename}
                  {key.publicKey && key.privateKey && <span style={{ color: 'var(--accent)', marginLeft: '6px', fontSize: '10px' }}>пара</span>}
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
                Сохранить
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Key list */}
      {keys.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>Сохранённые ключи</div>
          {keys.map((key) => (
            <div key={key.id} className={s.macroCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '13px' }}>
                  {key.name}
                  {key.has_private_key && <span style={{ color: 'var(--accent)', marginLeft: '6px', fontSize: '10px' }}>пара</span>}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {key.public_key.substring(0, 60)}...
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button
                  className={`${s.macroActionBtn} ${s.macroActionBtnDanger}`}
                  onClick={() => setDeleteConfirmId(key.id)}
                  title="Удалить"
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

      {/* Delete confirmation modal */}
      {deleteConfirmId !== null && (
        <div className={s.explainOverlay} onClick={() => setDeleteConfirmId(null)}>
          <div className={s.explainBox} onClick={(e) => e.stopPropagation()}>
            <div className={s.explainTitle}>Удалить SSH-ключ?</div>
            <div className={s.explainText}>Этот ключ будет удалён. Если он выбран как ключ по умолчанию для какого-либо сервера, ссылка будет сброшена.</div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className={s.cancelBtn} onClick={() => setDeleteConfirmId(null)}>Отмена</button>
              <button className={s.saveBtn} style={{ backgroundColor: 'var(--danger, #e53935)' }} onClick={() => handleDelete(deleteConfirmId)}>Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
