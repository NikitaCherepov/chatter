'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import styles from './UsersPage.module.css';

type Identity = { provider: string; provider_subject: string; username: string | null };
type UserOverview = {
  id: number;
  name: string | null;
  role: string;
  is_admin: boolean;
  status: string;
  plan: string;
  language: string | null;
  created_at: string | null;
  message_count: number;
  last_message_at: string | null;
  identities: Identity[];
  desktop: { online: boolean; connected_at: number | null; last_activity_at: number | null };
};
type UsersResponse = { users: UserOverview[]; total: number; limited: boolean };

const statusLabels: Record<string, string> = {
  approved: 'Активен',
  none: 'Ожидает',
  disapproved: 'Отклонён',
  banned: 'Заблокирован',
};
const planLabels: Record<string, string> = { free: 'Free', standart: 'Standard', pro: 'Pro' };

function formatDate(value: string | null) {
  if (!value) return '—';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function identityLabel(identity: Identity) {
  if (identity.username) {
    if (identity.provider !== 'telegram' || identity.username.startsWith('@')) return identity.username;
    return `@${identity.username}`;
  }
  return identity.provider_subject;
}

export function UsersPage() {
  const [users, setUsers] = useState<UserOverview[]>([]);
  const [total, setTotal] = useState(0);
  const [limited, setLimited] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [plan, setPlan] = useState('all');
  const [connection, setConnection] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadUsers = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api<UsersResponse>('/api/users');
      setUsers(response.users || []);
      setTotal(response.total || 0);
      setLimited(response.limited);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
    const timer = window.setInterval(() => void loadUsers(true), 10_000);
    return () => window.clearInterval(timer);
  }, [loadUsers]);

  const filteredUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter(user => {
      const matchesSearch = !needle || [
        user.name,
        String(user.id),
        ...user.identities.flatMap(identity => [identity.username, identity.provider_subject]),
      ].some(value => `${value || ''}`.toLowerCase().includes(needle));
      const matchesStatus = status === 'all' || user.status === status;
      const matchesPlan = plan === 'all' || user.plan === plan;
      const matchesConnection = connection === 'all'
        || (connection === 'online' ? user.desktop.online : !user.desktop.online);
      return matchesSearch && matchesStatus && matchesPlan && matchesConnection;
    });
  }, [connection, plan, search, status, users]);

  const onlineCount = users.filter(user => user.desktop.online).length;

  return (
    <div className={styles.stack}>
      <div className={styles.summary}>
        <span>{total} пользователей</span>
        <span><i className={styles.onlineDot} />{onlineCount} подключено</span>
        <button className="buttonSecondary" onClick={() => void loadUsers()} disabled={loading}>Обновить</button>
      </div>

      <Card title="Пользователи" description="Аккаунты, доступ и активность клиентов">
        <div className={styles.filters}>
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Имя, ID, Telegram или почта" aria-label="Поиск пользователей" />
          <select value={status} onChange={event => setStatus(event.target.value)} aria-label="Статус">
            <option value="all">Все статусы</option><option value="approved">Активные</option>
            <option value="none">Ожидают</option><option value="banned">Заблокированные</option>
            <option value="disapproved">Отклонённые</option>
          </select>
          <select value={plan} onChange={event => setPlan(event.target.value)} aria-label="Тариф">
            <option value="all">Все тарифы</option><option value="free">Free</option>
            <option value="standart">Standard</option><option value="pro">Pro</option>
          </select>
          <select value={connection} onChange={event => setConnection(event.target.value)} aria-label="Подключение">
            <option value="all">Любое подключение</option><option value="online">Desktop онлайн</option>
            <option value="offline">Desktop офлайн</option>
          </select>
        </div>

        {error && <div className={styles.error}>Не удалось загрузить пользователей: {error}</div>}
        {limited && <div className={styles.notice}>Показаны первые 500 аккаунтов.</div>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Пользователь</th><th>Статус</th><th>Тариф</th><th>Сообщений</th><th>Последнее сообщение</th><th>Создан</th></tr></thead>
            <tbody>
              {filteredUsers.map(user => (
                <tr key={user.id}>
                  <td><div className={styles.userCell}>
                    <i className={user.desktop.online ? styles.onlineDot : styles.offlineDot} title={user.desktop.online ? 'Desktop подключён' : 'Desktop не подключён'} />
                    <div><strong>{user.name || `Пользователь ${user.id}`}</strong><span>#{user.id}{user.identities[0] ? ` · ${identityLabel(user.identities[0])}` : ''}</span></div>
                  </div></td>
                  <td><div className={styles.badges}>
                    <span className={`${styles.badge} ${styles[`status_${user.status}`] || ''}`}>{statusLabels[user.status] || user.status}</span>
                    {user.is_admin && <span className={styles.adminBadge}>Админ</span>}
                  </div></td>
                  <td><span className={styles.plan}>{planLabels[user.plan] || user.plan}</span></td>
                  <td className={styles.number}>{user.message_count.toLocaleString('ru')}</td>
                  <td>{formatDate(user.last_message_at)}</td>
                  <td>{formatDate(user.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filteredUsers.length === 0 && <div className={styles.empty}>По выбранным фильтрам пользователей нет.</div>}
          {loading && users.length === 0 && <div className={styles.empty}>Загружаю пользователей…</div>}
        </div>
      </Card>
    </div>
  );
}
