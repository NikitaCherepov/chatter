'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import styles from './AccessKeysPage.module.css';

type AccessKey = {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_count: number;
  weekly_tokens_used: number;
};

const formatNumber = (value: number) => new Intl.NumberFormat('ru').format(Number(value) || 0);
const formatDate = (value: string | null) => value ? new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('ru') : '—';

export function AccessKeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [name, setName] = useState('');
  const [state, setState] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState('');
  const [serverUrl, setServerUrl] = useState('');

  const load = useCallback(async () => {
    const response = await api<{ keys: AccessKey[] }>('/api/server-access-keys');
    setKeys(response.keys || []);
  }, []);

  useEffect(() => {
    const directManager = Boolean(window.location.port && window.location.port !== '443');
    setServerUrl(directManager
      ? `${window.location.protocol}//${window.location.hostname}:3050`
      : `${window.location.origin}/backend`);
    void load().catch(error => setState(t('accessKeys.error', { message: error instanceof Error ? error.message : String(error) })));
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setState(t('accessKeys.creating'));
    try {
      const response = await api<{ key: { key: string } }>('/api/server-access-keys', {
        method: 'POST', body: JSON.stringify({ name }),
      });
      const link = `chatter://connect?server=${encodeURIComponent(serverUrl.trim())}&key=${encodeURIComponent(response.key.key)}`;
      setCreatedLink(link);
      setName('');
      setState(t('accessKeys.keyCreated'));
      await load();
    } catch (error) {
      setState(t('accessKeys.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setCreating(false); }
  }

  async function revoke(key: AccessKey) {
    if (!window.confirm(t('accessKeys.confirmRevoke', { name: key.name }))) return;
    await api(`/api/server-access-keys/${key.id}`, { method: 'DELETE', body: '{}' });
    setState(t('accessKeys.keyRevoked'));
    await load();
  }

  async function copyLink() {
    await navigator.clipboard.writeText(createdLink);
    setState(t('accessKeys.linkCopied'));
  }

  return (
    <div className={styles.stack}>
      <Card title={t('accessKeys.titleNew')} description={t('accessKeys.newKeyDescription')}>
        <form className={styles.createForm} onSubmit={create}>
          <label><span>{t('accessKeys.nameLabel')}</span><input value={name} onChange={event => setName(event.target.value)} placeholder={t('accessKeys.namePlaceholder')} maxLength={100} /></label>
          <label><span>{t('accessKeys.serverUrlLabel')}</span><input value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="http://1.2.3.4:3050" required /></label>
          <button type="submit" disabled={creating}>{creating ? t('accessKeys.creating') : t('accessKeys.createButton')}</button>
        </form>
        {createdLink && <div className={styles.created}><input value={createdLink} readOnly /><button type="button" onClick={() => void copyLink()}>{t('accessKeys.copyLink')}</button></div>}
        {state && <p className={styles.state}>{state}</p>}
      </Card>

      <Card title={t('accessKeys.issuedKeys')} description={t('accessKeys.issuedKeysDesc')}>
        <div className={styles.table}>
          <div className={styles.header}><span>{t('accessKeys.tableHeaders.key')}</span><span>{t('accessKeys.tableHeaders.users')}</span><span>{t('accessKeys.tableHeaders.tokensWeek')}</span><span>{t('accessKeys.tableHeaders.lastUsed')}</span><span /></div>
          {keys.map(key => <div className={styles.row} key={key.id}>
            <span><strong>{key.name}</strong><small>{key.key_prefix}{key.revoked_at ? ` · ${t('accessKeys.revoked')}` : ''}</small></span>
            <span>{formatNumber(key.user_count)}</span><span>{formatNumber(key.weekly_tokens_used)}</span>
            <span>{formatDate(key.last_used_at)}</span>
            <span>{key.revoked_at ? <small>{formatDate(key.revoked_at)}</small> : <button type="button" className="buttonSecondary" onClick={() => void revoke(key)}>{t('accessKeys.revoke')}</button>}</span>
          </div>)}
          {!keys.length && <div className={styles.empty}>{t('accessKeys.emptyState')}</div>}
        </div>
      </Card>
    </div>
  );
}
