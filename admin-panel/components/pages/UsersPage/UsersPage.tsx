'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api';
import { useTranslation } from 'react-i18next';
import { Card } from '../../ui/Card/Card';
import { Input } from '../../ui/Input/Input';
import { Select } from '../../ui/Select/Select';
import styles from './UsersPage.module.css';

type Identity = { provider: string; provider_subject: string; username: string | null };
type UserOverview = {
  id: number;
  name: string | null;
  role: string;
  is_admin: boolean;
  status: string;
  plan: string;
  weekly_tokens_used: number;
  weekly_tokens_quota: number;
  weekly_window_started_at: number;
  language: string | null;
  created_at: string | null;
  message_count: number;
  last_message_at: string | null;
  total_cost_usd: number | null;
  identities: Identity[];
  desktop: { online: boolean; connected_at: number | null; last_activity_at: number | null };
};
type UsersResponse = { users: UserOverview[]; total: number; limited: boolean };

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

function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd === 0) return '—';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function identityLabel(identity: Identity) {
  if (identity.username) {
    if (identity.provider !== 'telegram' || identity.username.startsWith('@')) return identity.username;
    return `@${identity.username}`;
  }
  return identity.provider_subject;
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('ru', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

function quotaPercent(used: number, quota: number): number {
  if (!quota || quota <= 0) return 0;
  return Math.min(100, Math.round((Number(used) || 0) / quota * 100));
}

function quotaLabel(used: number, quota: number): string {
  if (!quota || quota <= 0) return '∞';
  const percent = quotaPercent(used, quota);
  return `${percent}%`;
}

export function UsersPage({ onSelectUser }: { onSelectUser: (userId: number) => void }) {
  const [users, setUsers] = useState<UserOverview[]>([]);
  const [total, setTotal] = useState(0);
  const [limited, setLimited] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [plan, setPlan] = useState('all');
  const [connection, setConnection] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { t } = useTranslation();

  const statusLabels: Record<string, string> = {
    approved: t('users.list.status.approved'),
    none: t('users.list.status.none'),
    disapproved: t('users.list.status.disapproved'),
    banned: t('users.list.status.banned'),
  };

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
        <span>{t('users.list.totalUsers', { count: total })}</span>
        <span><i className={styles.onlineDot} />{t('users.list.onlineCount', { count: onlineCount })}</span>
        <button className="buttonSecondary" onClick={() => void loadUsers()} disabled={loading}>{t('users.list.refresh')}</button>
      </div>

      <Card title={t('users.list.title')} description={t('users.list.description')}>
        <div className={styles.filters}>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('users.list.searchPlaceholder')}
            aria-label={t('users.list.searchAriaLabel')}
          />
          <Select
            value={status}
            onChange={setStatus}
            aria-label={t('users.list.statusLabel')}
            options={[
              { value: 'all', label: t('users.list.filter.allStatuses') },
              { value: 'approved', label: t('users.list.filter.active') },
              { value: 'none', label: t('users.list.filter.pending') },
              { value: 'banned', label: t('users.list.filter.blocked') },
              { value: 'disapproved', label: t('users.list.filter.rejected') },
            ]}
          />
          <Select
            value={plan}
            onChange={setPlan}
            aria-label={t('users.list.planLabel')}
            options={[
              { value: 'all', label: t('users.list.filter.allPlans') },
              { value: 'free', label: 'Free' },
              { value: 'standart', label: 'Standard' },
              { value: 'pro', label: 'Pro' },
            ]}
          />
          <Select
            value={connection}
            onChange={setConnection}
            aria-label={t('users.list.connectionLabel')}
            options={[
              { value: 'all', label: t('users.list.filter.anyConnection') },
              { value: 'online', label: t('users.list.filter.desktopOnline') },
              { value: 'offline', label: t('users.list.filter.desktopOffline') },
            ]}
          />
        </div>

        {error && <div className={styles.error}>{t('users.list.loadError', { error })}</div>}
        {limited && <div className={styles.notice}>{t('users.list.limited')}</div>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>{t('users.list.tableHeaders.user')}</th><th>{t('users.list.tableHeaders.status')}</th><th>{t('users.list.tableHeaders.plan')}</th><th>{t('users.list.tableHeaders.quota')}</th><th>{t('users.list.tableHeaders.messages')}</th><th>{t('users.list.tableHeaders.totalCost')}</th><th>{t('users.list.tableHeaders.lastMessage')}</th><th>{t('users.list.tableHeaders.created')}</th></tr></thead>
            <tbody>
              {filteredUsers.map(user => {
                const used = user.weekly_tokens_used || 0;
                const quota = user.weekly_tokens_quota || 0;
                const percent = quotaPercent(used, quota);
                return (
                  <tr key={user.id}>
                    <td><div className={styles.userCell}>
                      <i className={user.desktop.online ? styles.onlineDot : styles.offlineDot} title={user.desktop.online ? t('users.list.desktopOnline') : t('users.list.desktopOffline')} />
                      <div><button className={styles.userLink} type="button" onClick={() => onSelectUser(user.id)}>{user.name || t('users.list.userDefaultName', { id: user.id })}</button><span>#{user.id}{user.identities[0] ? ` · ${identityLabel(user.identities[0])}` : ''}</span></div>
                    </div></td>
                    <td><div className={styles.badges}>
                      <span className={`${styles.badge} ${styles[`status_${user.status}`] || ''}`}>{statusLabels[user.status] || user.status}</span>
                      {user.is_admin && <span className={styles.adminBadge}>{t('users.list.adminBadge')}</span>}
                    </div></td>
                    <td><span className={styles.plan}>{planLabels[user.plan] || user.plan}</span></td>
                    <td>
                      {quota > 0 ? (
                        <div className={styles.quotaCell} title={t('users.list.quotaTooltip', { used: formatTokens(used), quota: formatTokens(quota) })}>
                          <div className={styles.quotaBar}><div className={styles.quotaBarFill} style={{ width: `${percent}%` }} data-warn={percent >= 90 || undefined} /></div>
                          <span className={styles.quotaLabel}>{quotaLabel(used, quota)}</span>
                        </div>
                      ) : (
                        <span className={styles.muted}>∞</span>
                      )}
                    </td>
                    <td className={styles.number}>{user.message_count.toLocaleString('ru')}</td>
                    <td className={styles.number}>{formatCost(user.total_cost_usd)}</td>
                    <td>{formatDate(user.last_message_at)}</td>
                    <td>{formatDate(user.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && filteredUsers.length === 0 && <div className={styles.empty}>{t('users.list.noResults')}</div>}
          {loading && users.length === 0 && <div className={styles.empty}>{t('users.list.loading')}</div>}
        </div>
      </Card>
    </div>
  );
}
