'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
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
    return () => window.clearInterval(timer);
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
        value: password ? identityValue(password) : 'Аккаунт для входа не создан',
        state: user.desktop.online ? 'Онлайн сейчас' : password ? 'Сейчас не подключён' : 'Не привязан',
        online: user.desktop.online,
        updated: user.desktop.online ? formatDate(user.desktop.last_activity_at) : password ? formatDate(password.updated_at) : '—',
      },
      {
        name: 'Telegram',
        linked: Boolean(telegram),
        value: telegram ? identityValue(telegram) : 'Telegram не привязан',
        state: telegram ? 'Привязан' : 'Не привязан',
        online: null,
        updated: telegram ? formatDate(telegram.updated_at) : '—',
      },
      ...extra.map(identity => ({
        name: identity.provider,
        linked: true,
        value: identityValue(identity),
        state: 'Привязан',
        online: null,
        updated: formatDate(identity.updated_at),
      })),
    ];
  }, [user]);

  async function changeRole(role: 'user' | 'admin') {
    if (!user || role === user.role) return;
    setActionState('Сохраняю роль…');
    try {
      await api(`/api/users/${user.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
      setActionState('Роль сохранена');
      await loadUser(true);
    } catch (roleError) {
      setActionState(`Ошибка: ${roleError instanceof Error ? roleError.message : String(roleError)}`);
    }
  }

  async function changeStatus(status: 'none' | 'approved' | 'disapproved') {
    if (!user || status === user.status) return;
    setActionState('Сохраняю статус…');
    try {
      await api(`/api/users/${user.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
      setActionState('Статус сохранён');
      await loadUser(true);
    } catch (statusError) {
      setActionState(`Ошибка: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
    }
  }

  async function changePlan(plan: UserPlan, duration: PlanDuration) {
    if (!user) return;
    setPlanSaving(true);
    setActionState('Сохраняю тариф…');
    try {
      await api(`/api/users/${user.id}/plan`, { method: 'PUT', body: JSON.stringify({ plan, duration }) });
      setActionState('Тариф и лимиты обновлены');
      setPendingPlan(null);
      await loadUser(true);
    } catch (planError) {
      setActionState(`Ошибка: ${planError instanceof Error ? planError.message : String(planError)}`);
    } finally {
      setPlanSaving(false);
    }
  }

  async function toggleBan() {
    if (!user) return;
    const unban = user.status === 'banned';
    setActionState(unban ? 'Разблокирую…' : 'Блокирую…');
    try {
      await api(`/api/users/${user.id}/ban`, unban
        ? { method: 'DELETE' }
        : { method: 'POST', body: JSON.stringify({ reason: banReason }) });
      setBanReason('');
      setActionState(unban ? 'Пользователь разблокирован и ожидает одобрения' : 'Пользователь заблокирован');
      await loadUser(true);
    } catch (banError) {
      setActionState(`Ошибка: ${banError instanceof Error ? banError.message : String(banError)}`);
    }
  }

  if (loading && !user) return <div className={styles.loading}>Загружаю пользователя…</div>;
  if (!user) return <div className={styles.loading}>Не удалось загрузить пользователя: {error}</div>;

  const weeklyPercent = user.weekly_tokens_quota > 0
    ? Math.min(100, Math.round((user.weekly_tokens_used || 0) / user.weekly_tokens_quota * 100))
    : 0;
  const weeklyResetsAt = user.weekly_window_started_at
    ? formatDate(new Date((user.weekly_window_started_at + 7 * 24 * 60 * 60) * 1000).toISOString())
    : '—';

  const stats = [
    ['Квота недели', user.weekly_tokens_quota > 0
      ? `${formatNumber(user.weekly_tokens_used)} / ${formatNumber(user.weekly_tokens_quota)} (${weeklyPercent}%)`
      : '∞'],
    ['Сброс квоты', weeklyResetsAt],
    ['Сообщения', formatNumber(user.messages.total)],
    ['Запросы пользователя', formatNumber(user.messages.user)],
    ['Ответы ассистента', formatNumber(user.messages.assistant)],
    ['Чаты', formatNumber(user.chats_count)],
    ['Поиск сегодня', `${formatNumber(user.daily_web_search_count)} / ${formatNumber(user.daily_web_search_limit)}`],
    ['Поиск всего', formatNumber(user.total_web_search_count)],
    ['Изображения сегодня', `${formatNumber(user.daily_image_gen_count)} / ${formatNumber(user.daily_image_gen_limit)}`],
    ['Изображения всего', formatNumber(user.total_image_gen_count)],
    ['Длина сообщений', formatNumber(user.total_message_length)],
    ['Последнее сообщение', formatDate(user.messages.last_message_at)],
  ];

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <button type="button" className="buttonSecondary" onClick={onBack}>← К пользователям</button>
        <button type="button" className="buttonSecondary" onClick={() => void loadUser()} disabled={loading}>Обновить</button>
      </div>

      <Card
        title={user.name || `Пользователь ${user.id}`}
        description={`ID ${user.id} · создан ${formatDate(user.created_at)}`}
        aside={<span className={user.desktop.online ? styles.online : styles.offline}>{user.desktop.online ? 'Desktop онлайн' : 'Desktop офлайн'}</span>}
      >
        <div className={styles.accountGrid}>
          <label><span>Роль</span><select value={user.role} onChange={event => void changeRole(event.target.value as 'user' | 'admin')}><option value="user">Пользователь</option><option value="admin">Администратор</option></select></label>
          <label><span>Статус</span><select value={user.status} disabled={user.status === 'banned'} onChange={event => void changeStatus(event.target.value as 'none' | 'approved' | 'disapproved')}><option value="none">Ожидает</option><option value="approved">Активен</option><option value="disapproved">Отклонён</option>{user.status === 'banned' && <option value="banned">Заблокирован</option>}</select></label>
          <label>
            <span>Тариф</span>
            <select value={user.plan} onChange={event => setPendingPlan(event.target.value as UserPlan)}>
              <option value="free">Free</option><option value="standart">Standard</option><option value="pro">Pro</option>
            </select>
            <small>{user.subscription?.ends_at ? `до ${formatDate(user.subscription.ends_at)}` : 'бессрочно'}</small>
            <button type="button" className={styles.durationButton} onClick={() => setPendingPlan(user.plan as UserPlan)}>Изменить срок</button>
          </label>
          <div><span>Язык</span><strong>{user.language || 'Не выбран'}</strong></div>
          <div><span>Предпочитаемая модель</span><strong>{user.preferred_model || 'Автоматически'}</strong></div>
          <div><span>Reasoning</span><strong>{user.reasoning_level || 'По умолчанию'}</strong></div>
          <div><span>Последний ключ Desktop</span><strong>{user.last_server_access_key ? `${user.last_server_access_key.name} · ${user.last_server_access_key.key_prefix}` : 'Не использовался'}</strong><small>{user.last_server_access_key ? formatDate(user.last_server_access_key.last_used_at) : '—'}</small></div>
        </div>
        <div className={styles.banBar}>
          <div><strong>{user.status === 'banned' ? 'Пользователь заблокирован' : 'Блокировка аккаунта'}</strong><span>{user.ban?.reason || 'Блокировка отзывает текущие сессии пользователя'}</span></div>
          {user.status !== 'banned' && <input value={banReason} onChange={event => setBanReason(event.target.value)} placeholder="Причина (необязательно)" disabled={user.role === 'admin'} />}
          <button type="button" className={styles.dangerButton} onClick={() => void toggleBan()} disabled={user.role === 'admin'}>{user.status === 'banned' ? 'Разблокировать' : 'Заблокировать'}</button>
        </div>
        {actionState && <p className={styles.actionState}>{actionState}</p>}
      </Card>

      <Card title="Подключения" description="Способы входа и текущее соединение Desktop">
        <div className={styles.connectionTable}>
          <div className={styles.connectionHeader}><span>Клиент</span><span>Аккаунт</span><span>Состояние</span><span>Активность</span></div>
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

      <Card title="Использование" description="Текущие накопленные счётчики без содержимого переписки">
        <div className={styles.statsGrid}>{stats.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      </Card>

      <UsageByModelCard userId={user.id} quotaUsed={user.weekly_tokens_used} quotaTotal={user.weekly_tokens_quota} />

      <Card title="Лимиты контекста" description="Технические значения, которые уже хранятся для аккаунта">
        <div className={styles.statsGrid}>
          <div><span>Лимит тарифа</span><strong>{formatNumber(user.max_context_tokens_limit)}</strong></div>
          <div><span>Выбранный контекст</span><strong>{formatNumber(user.max_context_tokens)}</strong></div>
          <div><span>Документы</span><strong>{user.attachment_max_tokens ? formatNumber(user.attachment_max_tokens) : 'Авто'}</strong></div>
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
  request_count: number;
};

const routeLabels: Record<string, string> = {
  'manual': 'Manual',
  'auto-pro': 'Auto PRO',
  'auto-lite': 'Auto LITE',
  'auto-vision': 'Auto Vision',
  'memory-merge': 'Память',
  'scheduler-condition': 'Планировщик',
};

function formatTokens(value: number) {
  return new Intl.NumberFormat('ru', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

function UsageDonut({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const color = clamped >= 90 ? '#e74' : clamped >= 70 ? '#ec4' : '#4a9';
  return (
    <svg viewBox="0 0 100 100" width="100" height="100" className={styles.donut}>
      <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--border, #2a2a2a)" strokeWidth="10" />
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

function UsageByModelCard({ userId, quotaUsed, quotaTotal }: { userId: number; quotaUsed: number; quotaTotal: number }) {
  const [rows, setRows] = useState<UsageByModelRow[] | null>(null);
  const [error, setError] = useState('');

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

  return (
    <Card title="Использование по моделям" description="За текущее недельное окно. Не зависит от удаления чатов.">
      <div className={styles.usageRow}>
        <div className={styles.usageDonut}>
          <UsageDonut percent={percent} />
          <div className={styles.usageDonutCaption}>
            <strong>{formatTokens(quotaUsed || 0)} / {quotaTotal > 0 ? formatTokens(quotaTotal) : '∞'}</strong>
            <small>условных единиц</small>
          </div>
        </div>
        <div className={styles.usageTableWrap}>
          {error && <div className={styles.error}>Не удалось загрузить: {error}</div>}
          {!rows && !error && <div className={styles.loading}>Загружаю…</div>}
          {rows && rows.length === 0 && <div className={styles.loading}>За текущее окно запросов пока нет.</div>}
          {rows && rows.length > 0 && (
            <table className={styles.usageTable}>
              <thead><tr>
                <th>Модель</th><th>Маршрут</th><th>Запросов</th>
                <th>Токенов</th><th>Cache hit</th><th>Списано</th>
              </tr></thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.model_id || 'null'}-${idx}`}>
                    <td><strong>{row.model_name || row.model_id || '—'}</strong><small>{row.provider_name || ''}</small></td>
                    <td>{row.route ? (routeLabels[row.route] || row.route) : '—'}</td>
                    <td>{row.request_count}{row.aborted_requests > 0 && <small title="прервано"> · {row.aborted_requests}⛔</small>}</td>
                    <td>{formatTokens(row.total_tokens)}</td>
                    <td>{formatTokens(row.cache_hit_tokens)}</td>
                    <td>{row.free_requests > 0 && row.charged_tokens === 0 ? <span title="бесплатная модель">free</span> : formatTokens(row.charged_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Card>
  );
}
