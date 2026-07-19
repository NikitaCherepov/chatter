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
  daily_tokens_used: number;
  total_tokens_used: number;
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

  const stats = [
    ['Токены сегодня', formatNumber(user.daily_tokens_used)],
    ['Токены всего', formatNumber(user.total_tokens_used)],
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
