'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { Select } from '../../ui/Select/Select';
import { PlanDurationModal, type PlanDuration, type UserPlan } from './PlanDurationModal/PlanDurationModal';
import styles from './UserDetailPage.module.css';

type Identity = {
  provider: string;
  provider_subject: string;
  username: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type UserDetail = {
  id: number;
  name: string | null;
  role: 'user' | 'admin';
  is_admin: boolean;
  status: string;
  plan: string;
  language: string | null;
  created_at: string | null;
  daily_message_count: number;
  weekly_tokens_used: number;
  weekly_tokens_quota: number;
  weekly_window_started_at: number;
  weekly_cost_used: number;
  weekly_cost_quota: number;
  weekly_cost_quota_limit: number;
  daily_web_search_count: number;
  daily_web_search_limit: number;
  total_web_search_count: number;
  daily_image_gen_count: number;
  daily_image_gen_limit: number;
  total_image_gen_count: number;
  total_message_length: number;
  preferred_model: string | null;
  reasoning_level: string | null;
  max_context_tokens_limit: number;
  max_context_tokens: number;
  attachment_max_tokens: number;
  chats_count: number;
  ban: { reason: string; banned_at: string; banned_by: number | null } | null;
  subscription: { plan: string; started_at: string; ends_at: string | null } | null;
  last_server_access_key: { id: number; name: string; key_prefix: string; last_used_at: string; revoked_at: string | null } | null;
  identities: Identity[];
  messages: { total: number; user: number; assistant: number; last_message_at: string | null };
  desktop: { online: boolean; connected_at: number | null; last_activity_at: number | null };
};

function formatNumber(value: number) {
  return new Intl.NumberFormat('ru').format(Number(value) || 0);
}

function formatDate(value: string | number | null) {
  if (!value) return '—';
  const normalized = typeof value === 'number'
    ? value
    : value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function identityValue(identity: Identity) {
  const username = identity.username
    ? identity.provider === 'telegram' && !identity.username.startsWith('@')
      ? `@${identity.username}`
      : identity.username
    : '';
  return [username, identity.provider_subject].filter(Boolean).join(' · ');
}

export function UserDetailPage({ userId, onBack }: { userId: number; onBack: () => void }) {
  const { t } = useTranslation();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionState, setActionState] = useState('');
  const [banReason, setBanReason] = useState('');
  const [pendingPlan, setPendingPlan] = useState<UserPlan | null>(null);
  const [planSaving, setPlanSaving] = useState(false);

  const loadUser = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api<{ user: UserDetail }>(`/api/users/${userId}`);
      setUser(response.user);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadUser();
    const timer = window.setInterval(() => void loadUser(true), 10_000);
    const reloadHandler = () => void loadUser(true);
    window.addEventListener('user-detail-reload', reloadHandler);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('user-detail-reload', reloadHandler);
    };
  }, [loadUser]);

  const connections = useMemo(() => {
    if (!user) return [];
    const password = user.identities.find(identity => identity.provider === 'password');
    const telegram = user.identities.find(identity => identity.provider === 'telegram');
    const extra = user.identities.filter(identity => !['password', 'telegram'].includes(identity.provider));
    return [
      {
        name: 'Desktop',
        linked: Boolean(password),
        value: password ? identityValue(password) : t('users.detail.noAccount'),
        state: user.desktop.online ? t('users.detail.onlineNow') : password ? t('users.detail.notConnected') : t('users.detail.notBound'),
        online: user.desktop.online,
        updated: user.desktop.online ? formatDate(user.desktop.last_activity_at) : password ? formatDate(password.updated_at) : '—',
      },
      {
        name: 'Telegram',
        linked: Boolean(telegram),
        value: telegram ? identityValue(telegram) : t('users.detail.telegramNotBound'),
        state: telegram ? t('users.detail.bound') : t('users.detail.notBound'),
        online: null,
        updated: telegram ? formatDate(telegram.updated_at) : '—',
      },
      ...extra.map(identity => ({
        name: identity.provider,
        linked: true,
        value: identityValue(identity),
        state: t('users.detail.bound'),
        online: null,
        updated: formatDate(identity.updated_at),
      })),
    ];
  }, [user]);

  async function changeRole(role: 'user' | 'admin') {
    if (!user || role === user.role) return;
    setActionState(t('users.detail.actions.savingRole'));
    try {
      await api(`/api/users/${user.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
      setActionState(t('users.detail.actions.roleSaved'));
      await loadUser(true);
    } catch (roleError) {
      setActionState(t('users.detail.actions.error', { error: roleError instanceof Error ? roleError.message : String(roleError) }));
    }
  }

  async function changeStatus(status: 'none' | 'approved' | 'disapproved') {
    if (!user || status === user.status) return;
    setActionState(t('users.detail.actions.savingStatus'));
    try {
      await api(`/api/users/${user.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
      setActionState(t('users.detail.actions.statusSaved'));
      await loadUser(true);
    } catch (statusError) {
      setActionState(t('users.detail.actions.error', { error: statusError instanceof Error ? statusError.message : String(statusError) }));
    }
  }

  async function changePlan(plan: UserPlan, duration: PlanDuration) {
    if (!user) return;
    setPlanSaving(true);
    setActionState(t('users.detail.actions.savingPlan'));
    try {
      await api(`/api/users/${user.id}/plan`, { method: 'PUT', body: JSON.stringify({ plan, duration }) });
      setActionState(t('users.detail.actions.planSaved'));
      setPendingPlan(null);
      await loadUser(true);
    } catch (planError) {
      setActionState(t('users.detail.actions.error', { error: planError instanceof Error ? planError.message : String(planError) }));
    } finally {
      setPlanSaving(false);
    }
  }

  async function toggleBan() {
    if (!user) return;
    const unban = user.status === 'banned';
    setActionState(unban ? t('users.detail.actions.unbanInProgress') : t('users.detail.actions.banInProgress'));
    try {
      await api(`/api/users/${user.id}/ban`, unban
        ? { method: 'DELETE' }
        : { method: 'POST', body: JSON.stringify({ reason: banReason }) });
      setBanReason('');
      setActionState(unban ? t('users.detail.actions.userUnbanned') : t('users.detail.actions.userBanned'));
      await loadUser(true);
    } catch (banError) {
      setActionState(t('users.detail.actions.error', { error: banError instanceof Error ? banError.message : String(banError) }));
    }
  }

  if (loading && !user) return <div className={styles.loading}>{t('users.detail.loading')}</div>;
  if (!user) return <div className={styles.loading}>{t('users.detail.loadError', { error })}</div>;

  const weeklyPercent = user.weekly_tokens_quota > 0
    ? Math.min(100, Math.round((user.weekly_tokens_used || 0) / user.weekly_tokens_quota * 100))
    : 0;
  const weeklyResetsAt = user.weekly_window_started_at
    ? formatDate(new Date((user.weekly_window_started_at + 7 * 24 * 60 * 60) * 1000).toISOString())
    : '—';

  const stats = [
    [t('users.detail.usage.stats.weeklyQuota'), user.weekly_tokens_quota > 0
      ? `${formatNumber(user.weekly_tokens_used)} / ${formatNumber(user.weekly_tokens_quota)} (${weeklyPercent}%)`
      : '∞'],
    [t('users.detail.usage.stats.quotaReset'), weeklyResetsAt],
    [t('users.detail.usage.stats.messages'), formatNumber(user.messages.total)],
    [t('users.detail.usage.stats.userRequests'), formatNumber(user.messages.user)],
    [t('users.detail.usage.stats.assistantResponses'), formatNumber(user.messages.assistant)],
    [t('users.detail.usage.stats.chats'), formatNumber(user.chats_count)],
    [t('users.detail.usage.stats.searchToday'), `${formatNumber(user.daily_web_search_count)} / ${formatNumber(user.daily_web_search_limit)}`],
    [t('users.detail.usage.stats.searchTotal'), formatNumber(user.total_web_search_count)],
    [t('users.detail.usage.stats.imagesToday'), `${formatNumber(user.daily_image_gen_count)} / ${formatNumber(user.daily_image_gen_limit)}`],
    [t('users.detail.usage.stats.imagesTotal'), formatNumber(user.total_image_gen_count)],
    [t('users.detail.usage.stats.messageLength'), formatNumber(user.total_message_length)],
    [t('users.detail.usage.stats.lastMessage'), formatDate(user.messages.last_message_at)],
  ];

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <button type="button" className="buttonSecondary" onClick={onBack}>{t('users.detail.back')}</button>
        <button type="button" className="buttonSecondary" onClick={() => void loadUser()} disabled={loading}>{t('users.detail.refresh')}</button>
      </div>

      <Card
        title={user.name || t('users.list.userDefaultName', { id: user.id })}
        description={t('users.detail.description', { id: user.id, created: formatDate(user.created_at) })}
        aside={<span className={user.desktop.online ? styles.online : styles.offline}>{user.desktop.online ? t('users.detail.desktopOnline') : t('users.detail.desktopOffline')}</span>}
      >
        <div className={styles.accountGrid}>
          <div>
            <span>{t('users.detail.roleLabel')}</span>
            <Select
              value={user.role}
              onChange={(value) => void changeRole(value as 'user' | 'admin')}
              options={[
                { value: 'user', label: t('users.detail.roleUser') },
                { value: 'admin', label: t('users.detail.roleAdmin') },
              ]}
            />
          </div>
          <div>
            <span>{t('users.detail.statusLabel')}</span>
            <Select
              value={user.status}
              disabled={user.status === 'banned'}
              onChange={(value) => void changeStatus(value as 'none' | 'approved' | 'disapproved')}
              options={[
                { value: 'none', label: t('users.list.status.none') },
                { value: 'approved', label: t('users.list.status.approved') },
                { value: 'disapproved', label: t('users.list.status.disapproved') },
                ...(user.status === 'banned' ? [{ value: 'banned', label: t('users.list.status.banned') }] : []),
              ]}
            />
          </div>
          <div>
            <span>{t('users.detail.planLabel')}</span>
            <Select
              value={user.plan}
              onChange={(value) => setPendingPlan(value as UserPlan)}
              options={[
                { value: 'free', label: 'Free' },
                { value: 'standart', label: 'Standard' },
                { value: 'pro', label: 'Pro' },
              ]}
            />
            <small>{user.subscription?.ends_at ? t('users.detail.planUntil', { date: formatDate(user.subscription.ends_at) }) : t('users.detail.planForever')}</small>
            <button type="button" className={styles.durationButton} onClick={() => setPendingPlan(user.plan as UserPlan)}>{t('users.detail.changeDuration')}</button>
          </div>
          <div><span>{t('users.detail.languageLabel')}</span><strong>{user.language || t('users.detail.languageNotSet')}</strong></div>
          <div><span>{t('users.detail.preferredModelLabel')}</span><strong>{user.preferred_model || t('users.detail.preferredModelAuto')}</strong></div>
          <div><span>{t('users.detail.reasoningLabel')}</span><strong>{user.reasoning_level || t('users.detail.reasoningDefault')}</strong></div>
          <div><span>{t('users.detail.lastDesktopKey')}</span><strong>{user.last_server_access_key ? `${user.last_server_access_key.name} · ${user.last_server_access_key.key_prefix}` : t('users.detail.desktopKeyNotUsed')}</strong><small>{user.last_server_access_key ? formatDate(user.last_server_access_key.last_used_at) : '—'}</small></div>
        </div>
        <div className={styles.banBar}>
          <div><strong>{user.status === 'banned' ? t('users.detail.ban.banned') : t('users.detail.ban.blockAccount')}</strong><span>{user.ban?.reason || t('users.detail.ban.banHint')}</span></div>
          {user.status !== 'banned' && <input value={banReason} onChange={event => setBanReason(event.target.value)} placeholder={t('users.detail.ban.reasonPlaceholder')} disabled={user.role === 'admin'} />}
          <button type="button" className={styles.dangerButton} onClick={() => void toggleBan()} disabled={user.role === 'admin'}>{user.status === 'banned' ? t('users.detail.ban.unban') : t('users.detail.ban.ban')}</button>
        </div>
        {actionState && <p className={styles.actionState}>{actionState}</p>}
      </Card>

      <Card title={t('users.detail.connections.title')} description={t('users.detail.connections.description')}>
        <div className={styles.connectionTable}>
          <div className={styles.connectionHeader}><span>{t('users.detail.connections.headers.client')}</span><span>{t('users.detail.connections.headers.account')}</span><span>{t('users.detail.connections.headers.state')}</span><span>{t('users.detail.connections.headers.activity')}</span></div>
          {connections.map(connection => (
            <div className={styles.connectionRow} key={connection.name}>
              <strong>{connection.name}</strong>
              <span>{connection.value}</span>
              <span className={styles.connectionState}>
                <i className={connection.online === true ? styles.dotOnline : connection.online === false || !connection.linked ? styles.dotOffline : styles.dotLinked} />
                {connection.state}
              </span>
              <span>{connection.updated}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t('users.detail.usage.title')} description={t('users.detail.usage.description')}>
        <div className={styles.statsGrid}>{stats.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      </Card>

      <UsageByModelCard
        userId={user.id}
        quotaUsed={user.weekly_tokens_used}
        quotaTotal={user.weekly_tokens_quota}
        costUsed={user.weekly_cost_used}
        costQuota={user.weekly_cost_quota}
      />

      <Card title={t('users.detail.contextLimits.title')} description={t('users.detail.contextLimits.description')}>
        <div className={styles.statsGrid}>
          <div><span>{t('users.detail.contextLimits.planLimit')}</span><strong>{formatNumber(user.max_context_tokens_limit)}</strong></div>
          <div><span>{t('users.detail.contextLimits.selectedContext')}</span><strong>{formatNumber(user.max_context_tokens)}</strong></div>
          <div><span>{t('users.detail.contextLimits.documents')}</span><strong>{user.attachment_max_tokens ? formatNumber(user.attachment_max_tokens) : t('users.detail.contextLimits.documentsAuto')}</strong></div>
        </div>
      </Card>
      {pendingPlan && (
        <PlanDurationModal
          plan={pendingPlan}
          saving={planSaving}
          onCancel={() => setPendingPlan(null)}
          onConfirm={duration => void changePlan(pendingPlan, duration)}
        />
      )}
    </div>
  );
}

// ─── Usage by model (donut + table) ─────────────────────────────────────────

type UsageByModelRow = {
  model_id: string | null;
  model_name: string | null;
  route: string | null;
  provider_name: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  charged_tokens: number;
  free_requests: number;
  aborted_requests: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  request_count: number;
};

function formatTokens(value: number) {
  return new Intl.NumberFormat('ru', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

function formatCostUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.000001) return `$${usd.toFixed(8)}`;
  return `$${usd.toFixed(6)}`;
}

/** Prefer actual_cost_usd (real OpenRouter cost); fall back to estimated. */
function rowCost(row: UsageByModelRow): number | null {
  if (row.actual_cost_usd !== null && row.actual_cost_usd !== undefined && Number.isFinite(row.actual_cost_usd) && row.actual_cost_usd > 0) {
    return row.actual_cost_usd;
  }
  if (row.estimated_cost_usd !== null && row.estimated_cost_usd !== undefined && Number.isFinite(row.estimated_cost_usd) && row.estimated_cost_usd > 0) {
    return row.estimated_cost_usd;
  }
  return null;
}

function UsageDonut({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const color = clamped >= 90
    ? 'var(--color-error)'
    : clamped >= 70
      ? 'var(--color-warning)'
      : 'var(--color-success)';
  return (
    <svg viewBox="0 0 100 100" width="100" height="100" className={styles.donut}>
      <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--border-light)" strokeWidth="10" />
      <circle
        cx="50" cy="50" r={radius} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={circumference} strokeDashoffset={offset}
        transform="rotate(-90 50 50)"
        style={{ transition: 'stroke-dashoffset 0.4s ease' }}
      />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="middle" className={styles.donutText} fill="currentColor">
        {clamped}%
      </text>
    </svg>
  );
}

function UsageByModelCard({ userId, quotaUsed, quotaTotal, costUsed, costQuota }: {
  userId: number;
  quotaUsed: number;
  quotaTotal: number;
  costUsed: number;
  costQuota: number;
}) {
  const { t } = useTranslation();
  const routeLabels: Record<string, string> = {
    'manual': 'Manual',
    'auto-pro': 'Auto PRO',
    'auto-lite': 'Auto LITE',
    'auto-vision': 'Auto Vision',
    'memory-merge': t('users.detail.contextBreakdown.memoryMerge'),
    'scheduler-condition': t('users.detail.contextBreakdown.schedulerCondition'),
  };
  const [rows, setRows] = useState<UsageByModelRow[] | null>(null);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetState, setResetState] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api<{ by_model: UsageByModelRow[] }>(`/api/users/${userId}/usage`);
        if (!cancelled) {
          setRows(response.by_model || []);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const percent = quotaTotal > 0 ? Math.min(100, Math.round((quotaUsed || 0) / quotaTotal * 100)) : 0;

  async function resetWeeklyUsage() {
    if (!window.confirm(t('users.detail.modelUsage.resetUsageConfirm'))) return;
    setResetting(true);
    setResetState(t('users.detail.modelUsage.resetting'));
    try {
      await api(`/api/users/${userId}/reset-weekly-usage`, { method: 'POST', body: '{}' });
      setResetState(t('users.detail.modelUsage.resetDone'));
      // Reload user data to reflect zeroed counters
      window.dispatchEvent(new CustomEvent('user-detail-reload'));
    } catch (err) {
      setResetState(t('users.detail.modelUsage.resetError', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setResetting(false);
    }
  }

  const resetAside = (
    <button
      type="button"
      className="buttonDanger"
      onClick={() => void resetWeeklyUsage()}
      disabled={resetting}
      title={t('users.detail.modelUsage.resetUsageHint')}
    >
      {resetting ? t('users.detail.modelUsage.resetting') : t('users.detail.modelUsage.resetUsage')}
    </button>
  );

  return (
    <Card title={t('users.detail.modelUsage.title')} description={t('users.detail.modelUsage.description')} aside={resetAside}>
      <div className={styles.usageRow}>
        <div className={styles.usageDonuts}>
          <div className={styles.usageDonut}>
            <UsageDonut percent={percent} />
            <div className={styles.usageDonutCaption}>
              <strong>{formatTokens(quotaUsed || 0)} / {quotaTotal > 0 ? formatTokens(quotaTotal) : '∞'}</strong>
              <small>{t('users.detail.modelUsage.conditionalUnits')}</small>
            </div>
          </div>
          {costQuota > 0 && (
            <div className={styles.usageDonut}>
              <UsageDonut percent={Math.min(100, Math.round((costUsed || 0) / costQuota * 100))} />
              <div className={styles.usageDonutCaption}>
                <strong>{formatCostUsd(costUsed || 0)} / {formatCostUsd(costQuota)}</strong>
                <small>{t('users.detail.modelUsage.weeklyCost')}</small>
              </div>
            </div>
          )}
        </div>
        <div className={styles.usageTableWrap}>
          {error && <div className={styles.error}>{t('users.detail.modelUsage.loadError', { error })}</div>}
          {!rows && !error && <div className={styles.loading}>{t('users.detail.modelUsage.loading')}</div>}
          {rows && rows.length === 0 && <div className={styles.loading}>{t('users.detail.modelUsage.empty')}</div>}
          {rows && rows.length > 0 && (
            <table className={styles.usageTable}>
              <thead><tr>
                <th>{t('users.detail.modelUsage.tableHeaders.model')}</th><th>{t('users.detail.modelUsage.tableHeaders.route')}</th><th>{t('users.detail.modelUsage.tableHeaders.requests')}</th>
                <th>{t('users.detail.modelUsage.tableHeaders.tokens')}</th><th>{t('users.detail.modelUsage.tableHeaders.cacheHit')}</th><th>{t('users.detail.modelUsage.tableHeaders.charged')}</th>
                <th>{t('users.detail.modelUsage.tableHeaders.cost')}</th>
              </tr></thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.model_id || 'null'}-${idx}`}>
                    <td><strong>{row.model_name || row.model_id || '—'}</strong><small>{row.provider_name || ''}</small></td>
                    <td>{row.route ? (routeLabels[row.route] || row.route) : '—'}</td>
                    <td>{row.request_count}{row.aborted_requests > 0 && <small title={t('users.detail.modelUsage.aborted')}> · {row.aborted_requests}⛔</small>}</td>
                    <td>{formatTokens(row.total_tokens)}</td>
                    <td>{formatTokens(row.cache_hit_tokens)}</td>
                    <td>{row.free_requests > 0 && row.charged_tokens === 0 ? <span title={t('users.detail.modelUsage.freeTooltip')}>{t('users.detail.modelUsage.free')}</span> : formatTokens(row.charged_tokens)}</td>
                    <td>{formatCostUsd(rowCost(row))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {resetState && <p className={styles.actionState}>{resetState}</p>}
    </Card>
  );
}
