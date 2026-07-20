'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
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
    void load().catch(error => setState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`));
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setState('Создаю ключ…');
    try {
      const response = await api<{ key: { key: string } }>('/api/server-access-keys', {
        method: 'POST', body: JSON.stringify({ name }),
      });
      const link = `chatter://connect?server=${encodeURIComponent(serverUrl.trim())}&key=${encodeURIComponent(response.key.key)}`;
      setCreatedLink(link);
      setName('');
      setState('Ключ создан. Полное значение показывается только сейчас.');
      await load();
    } catch (error) {
      setState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setCreating(false); }
  }

  async function revoke(key: AccessKey) {
    if (!window.confirm(`Отозвать ключ «${key.name}»?`)) return;
    await api(`/api/server-access-keys/${key.id}`, { method: 'DELETE', body: '{}' });
    setState('Ключ отозван. Выданные через него JWT больше не действуют.');
    await load();
  }

  async function copyLink() {
    await navigator.clipboard.writeText(createdLink);
    setState('Ссылка скопирована.');
  }

  return (
    <div className={styles.stack}>
      <Card title="Новый ключ" description="Один ключ может использоваться несколькими аккаунтами и компьютерами">
        <form className={styles.createForm} onSubmit={create}>
          <label><span>Название</span><input value={name} onChange={event => setName(event.target.value)} placeholder="Например, друзья или семья" maxLength={100} /></label>
          <label><span>Адрес Backend</span><input value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="http://1.2.3.4:3050" required /></label>
          <button type="submit" disabled={creating}>{creating ? 'Создаю…' : 'Создать ключ'}</button>
        </form>
        {createdLink && <div className={styles.created}><input value={createdLink} readOnly /><button type="button" onClick={() => void copyLink()}>Копировать ссылку</button></div>}
        {state && <p className={styles.state}>{state}</p>}
      </Card>

      <Card title="Выданные ключи" description="Статистика считается по аккаунтам, которые входили через ключ">
        <div className={styles.table}>
          <div className={styles.header}><span>Ключ</span><span>Пользователи</span><span>Токенов за неделю</span><span>Последнее использование</span><span /></div>
          {keys.map(key => <div className={styles.row} key={key.id}>
            <span><strong>{key.name}</strong><small>{key.key_prefix}{key.revoked_at ? ' · отозван' : ''}</small></span>
            <span>{formatNumber(key.user_count)}</span><span>{formatNumber(key.weekly_tokens_used)}</span>
            <span>{formatDate(key.last_used_at)}</span>
            <span>{key.revoked_at ? <small>{formatDate(key.revoked_at)}</small> : <button type="button" className="buttonSecondary" onClick={() => void revoke(key)}>Отозвать</button>}</span>
          </div>)}
          {!keys.length && <div className={styles.empty}>Ключей пока нет. До создания первого ключа старый вход остаётся доступен.</div>}
        </div>
      </Card>
    </div>
  );
}
