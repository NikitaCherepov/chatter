'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ApiKey, ProviderModelConfig, Settings } from '../../../lib/types';
import { Select } from '../../ui/Select/Select';
import styles from './ModelConfigTransfer.module.css';

type Role = 'pro' | 'lite' | 'manual' | 'vision';
type Row = ProviderModelConfig & { name?: string; roles: Role[]; keyRef?: string; enabled?: boolean; billing?: Record<string, unknown> };
type Transfer = { format: 'chatter-models'; version: 1; models: Row[]; keys: { id: string; sourceId?: number; name: string; key?: string }[]; warnings: string[] };
const roles: Role[] = ['pro', 'lite', 'manual', 'vision'];

export function ModelConfigTransfer({ onImported }: { onImported: (settings: Partial<Settings>) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'import' | 'export' | null>(null);
  const [data, setData] = useState<Transfer | null>(null);
  const [savedKeys, setSavedKeys] = useState<ApiKey[]>([]);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const close = () => { if (!busy) { setMode(null); setData(null); setError(''); } };
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!mode) return;
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setMode(null); setData(null); setError(''); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); before?.focus(); };
  }, [mode, busy]);

  const open = async (next: 'import' | 'export') => {
    setMode(next); setError(''); setData(null); setNotice('');
    if (next === 'import') {
      try { setSavedKeys(await api<ApiKey[]>('/api/api-keys')); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
  };
  const load = async (file: File) => {
    if (busy) return;
    const zip = file.name.toLowerCase().endsWith('.zip');
    if (file.size > (zip ? 256 : 2) * 1024 * 1024) { setError(t('models.transfer.tooLarge')); return; }
    setBusy(true); setError(''); setData(null);
    requestRef.current = new AbortController();
    try {
      const result = await api<Transfer>('/api/model-config/preview', {
        method: 'POST', body: zip ? file : await file.text(),
        headers: { 'Content-Type': zip ? 'application/zip' : 'application/json' }, signal: requestRef.current.signal,
      });
      setData({ ...result, models: result.models.map(m => ({ ...m, enabled: true, apiKey: '', hasApiKey: false })) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const patchRow = (index: number, patch: Partial<Row>) => setData(current => current && ({
    ...current, models: current.models.map((m, i) => i === index ? { ...m, ...patch } : m),
  }));
  const selected = data?.models.filter(m => m.enabled) || [];
  const ready = selected.length > 0 && selected.every(m => m.baseUrl && m.model && m.roles.length &&
    (m.apiKeyId || (m.keyRef && data?.keys.some(k => k.id === m.keyRef && k.name.trim() && k.key?.trim()))));
  const commit = async () => {
    if (!data || !ready) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ added: number; skipped: number; settings: Partial<Settings> }>('/api/model-config/import', {
        method: 'POST', body: JSON.stringify({ ...data, models: selected }),
      });
      onImported(result.settings);
      window.dispatchEvent(new Event('chatter:api-keys-changed'));
      window.dispatchEvent(new Event('chatter:model-settings-changed'));
      setNotice(t('models.transfer.result', { added: result.added, skipped: result.skipped }));
      setMode(null); setData(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<Transfer>(`/api/model-config/export?includeKeys=${includeKeys}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'chatter-models.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMode(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <div className={styles.toolbar}>
      <div><strong>{t('models.transfer.title')}</strong><small>{t('models.transfer.subtitle')}</small></div>
      <div className={styles.buttons}>
        <button type="button" className="buttonSecondary" onClick={() => void open('import')}>{t('models.transfer.import')}</button>
        <button type="button" className="buttonSecondary" onClick={() => void open('export')}>{t('models.transfer.export')}</button>
      </div>
    </div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {mode && createPortal(<div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles.dialog} ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="model-transfer-title">
        <header><h2 id="model-transfer-title">{t(`models.transfer.${mode}`)}</h2><p>{t(mode === 'import' ? 'models.transfer.importHint' : 'models.transfer.exportHint')}</p></header>
        <div className={styles.body}>
          {mode === 'export' ? <>
            <label className={styles.check}><input type="checkbox" checked={includeKeys} onChange={e => setIncludeKeys(e.target.checked)} />{t('models.transfer.includeKeys')}</label>
            {includeKeys && <p className={styles.warning}>{t('models.transfer.secretWarning')}</p>}
          </> : <>
            <label className={styles.dropzone} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) void load(e.dataTransfer.files[0]); }}>
              {busy ? t('common.saving') : t('models.transfer.drop')}
              <input ref={fileRef} disabled={busy} type="file" accept=".zip,.json" onChange={e => { if (e.target.files?.[0]) void load(e.target.files[0]); e.target.value = ''; }} />
            </label>
            {data && <>
              {data.keys.length > 0 && <section><h3>{t('models.transfer.keys')}</h3><p>{t('models.transfer.keysHint')}</p>
                {data.keys.map((key, i) => <div key={key.id} className={styles.keyRow}>
                  <input aria-label={t('security.apiKeyName')} value={key.name} disabled={busy} onChange={e => setData(current => current && ({ ...current, keys: current.keys.map((k, j) => j === i ? { ...k, name: e.target.value } : k) }))} />
                  <input type="password" autoComplete="new-password" aria-label={t('security.apiKeyValue')} value={key.key || ''} disabled={busy} placeholder={t('security.apiKeyValue')} onChange={e => setData(current => current && ({ ...current, keys: current.keys.map((k, j) => j === i ? { ...k, key: e.target.value } : k) }))} />
                </div>)}
              </section>}
              <div className={styles.tableWrap}><table><thead><tr><th>{t('models.transfer.model')}</th><th>{t('models.transfer.key')}</th><th>{t('models.transfer.roles')}</th></tr></thead><tbody>
                {data.models.map((m, i) => <tr key={`${m.id}-${i}`}>
                  <td><label className={styles.check}><input type="checkbox" disabled={busy} checked={m.enabled} onChange={e => patchRow(i, { enabled: e.target.checked })} /><strong>{m.name || m.model}</strong></label>
                    <small>{m.model}</small><input aria-label={t('models.providerFields.baseUrl')} value={m.baseUrl} disabled={busy || !m.enabled} placeholder="https://…/v1" onChange={e => patchRow(i, { baseUrl: e.target.value })} />
                  </td>
                  <td><Select disabled={busy || !m.enabled} value={m.apiKeyId ? `saved:${m.apiKeyId}` : m.keyRef ? `import:${m.keyRef}` : ''}
                    placeholder={t('security.apiKeySelectPlaceholder')}
                    options={[...savedKeys.map(k => ({ value: `saved:${k.id}`, label: k.name })), ...data.keys.map(k => ({ value: `import:${k.id}`, label: k.name }))]}
                    onChange={value => value.startsWith('saved:') ? patchRow(i, { apiKeyId: Number(value.slice(6)), keyRef: undefined }) : patchRow(i, { apiKeyId: null, keyRef: value.slice(7) })} />
                    <button type="button" className="buttonSecondary" disabled={busy || !m.enabled} onClick={() => {
                      const id = `new-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                      setData(current => current && ({ ...current, keys: [...current.keys, { id, name: m.name || m.model, key: '' }], models: current.models.map((row, j) => j === i ? { ...row, keyRef: id, apiKeyId: null } : row) }));
                    }}>{t('security.apiKeyCreateNew')}</button>
                  </td>
                  <td><div className={styles.roles}>{roles.map(role => <label key={role} className={styles.check}><input type="checkbox" disabled={busy || !m.enabled} checked={m.roles.includes(role)} onChange={e => patchRow(i, { roles: e.target.checked ? [...m.roles, role] : m.roles.filter(r => r !== role) })} />{role === 'manual' ? t('models.manual.title') : role.toUpperCase()}</label>)}</div></td>
                </tr>)}
              </tbody></table></div>
              <p>{t('models.transfer.noOverwrite')}</p>
              {data.warnings.map(w => <p key={w} className={styles.warning}>{t(`models.transfer.warnings.${w}`, { defaultValue: w })}</p>)}
            </>}
          </>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </div>
        <footer><button type="button" className="buttonSecondary" disabled={busy} onClick={close}>{t('common.cancel')}</button>
          <button type="button" disabled={busy || (mode === 'import' && !ready)} onClick={() => void (mode === 'export' ? download() : commit())}>{busy ? t('common.saving') : t(mode === 'export' ? 'models.transfer.download' : 'models.transfer.confirm')}</button>
        </footer>
      </div>
    </div>, document.body)}
  </>;
}
