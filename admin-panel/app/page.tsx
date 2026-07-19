'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Settings = {
  telegramEnabled: boolean;
  notesUrl: string;
  aiBaseUrl: string;
  aiModel: string;
  voiceMode: 'off' | 'local' | 'remote';
  voiceExternalUrl: string;
  hasTelegramToken: boolean;
  hasAiApiKey: boolean;
  hasVoiceToken: boolean;
};

type Service = { service: string; state: string; health: string; status: string };

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

const emptySettings: Settings = {
  telegramEnabled: false,
  notesUrl: '',
  aiBaseUrl: 'https://openrouter.ai/api/v1',
  aiModel: '',
  voiceMode: 'off',
  voiceExternalUrl: '',
  hasTelegramToken: false,
  hasAiApiKey: false,
  hasVoiceToken: false
};

function SecretState({ configured }: { configured: boolean }) {
  return <span className={`tag ${configured ? '' : 'tagMissing'}`}>{configured ? 'сохранён' : 'не задан'}</span>;
}

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [username, setUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [telegramToken, setTelegramToken] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [voiceToken, setVoiceToken] = useState('');
  const [services, setServices] = useState<Service[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [accountState, setAccountState] = useState('');

  const loadData = useCallback(async () => {
    const [loadedSettings, status, session] = await Promise.all([
      api<Settings>('/api/settings'),
      api<{ services: Service[] }>('/api/status'),
      api<{ username: string }>('/api/session')
    ]);
    setSettings(loadedSettings);
    setServices(status.services || []);
    setUsername(session.username);
  }, []);

  useEffect(() => {
    api<{ authenticated: boolean; username: string }>('/api/session')
      .then(async (session) => {
        setAuthenticated(true);
        setUsername(session.username);
        await loadData();
      })
      .catch(() => setAuthenticated(false));
  }, [loadData]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setLoginError('');
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password: loginPassword }) });
      setLoginPassword('');
      setAuthenticated(true);
      await loadData();
    } catch (error) {
      setLoginError(error instanceof Error && error.message === 'invalid_credentials' ? 'Неверный логин или пароль.' : String(error));
    }
  }

  async function logout() {
    await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    setAuthenticated(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveState('Сохраняю настройки и запускаю контейнеры…');
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...settings, telegramToken, aiApiKey, voiceToken })
      });
      setTelegramToken('');
      setAiApiKey('');
      setVoiceToken('');
      setSaveState('Готово.');
      await loadData();
    } catch (error) {
      setSaveState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function changeAccount(event: FormEvent) {
    event.preventDefault();
    setAccountState('Сохраняю…');
    try {
      await api('/api/account', { method: 'PUT', body: JSON.stringify({ username, currentPassword, newPassword }) });
      setCurrentPassword('');
      setNewPassword('');
      setAccountState('Изменено. Войди снова.');
      setTimeout(() => setAuthenticated(false), 700);
    } catch (error) {
      setAccountState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (authenticated === null) return <main className="center"><div className="loader" /></main>;

  if (!authenticated) {
    return (
      <main className="shell">
        <section className="card loginCard">
          <Brand />
          <h1>Вход в панель</h1>
          <p className="muted">Данные для первого входа показал установщик.</p>
          <form onSubmit={login}>
            <label>Логин<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
            <label>Пароль<input value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
            <button type="submit">Войти</button>
          </form>
          <p className="error">{loginError}</p>
        </section>
      </main>
    );
  }

  const serviceMap = new Map(services.map((service) => [service.service, service]));

  return (
    <main className="shell">
      <header><div><Brand /><p className="muted">Базовая настройка сервера</p></div><button className="secondary compact" onClick={logout}>Выйти</button></header>
      <div className="statusGrid">
        {['backend', 'telegram-bot', 'webapp-notes', 'voice'].map((name) => {
          const service = serviceMap.get(name);
          const state = service?.state || 'stopped';
          return <div className={`status ${state.toLowerCase()}`} key={name}><strong>{name}</strong><small>{service?.health || service?.status || 'не запущен'}</small></div>;
        })}
      </div>

      <form className="stack" onSubmit={save}>
        <section className="card">
          <h2>Модель</h2>
          <p className="muted">OpenAI-совместимый API. Пустой ключ оставит уже сохранённый.</p>
          <div className="twoColumns">
            <label>Адрес API<input type="url" value={settings.aiBaseUrl} onChange={(event) => setSettings({ ...settings, aiBaseUrl: event.target.value })} required /></label>
            <label>Модель<input value={settings.aiModel} onChange={(event) => setSettings({ ...settings, aiModel: event.target.value })} placeholder="По умолчанию из backend" /></label>
          </div>
          <label>API-ключ <SecretState configured={settings.hasAiApiKey} /><input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} autoComplete="off" placeholder="Оставь пустым, чтобы не менять" /></label>
        </section>

        <section className="card">
          <div className="sectionHeading">
            <div><h2>Telegram</h2><p className="muted">Бот и приложение заметок запускаются вместе.</p></div>
            <label className="switch"><input type="checkbox" checked={settings.telegramEnabled} onChange={(event) => setSettings({ ...settings, telegramEnabled: event.target.checked })} /><span /></label>
          </div>
          <label>Токен бота <SecretState configured={settings.hasTelegramToken} /><input type="password" value={telegramToken} onChange={(event) => setTelegramToken(event.target.value)} autoComplete="off" placeholder="Оставь пустым, чтобы не менять" /></label>
          <label>HTTPS-адрес приложения заметок<input type="url" value={settings.notesUrl} onChange={(event) => setSettings({ ...settings, notesUrl: event.target.value })} placeholder="https://example.com" /></label>
        </section>

        <section className="card">
          <h2>Voice</h2>
          <label>Режим<select value={settings.voiceMode} onChange={(event) => setSettings({ ...settings, voiceMode: event.target.value as Settings['voiceMode'] })}><option value="off">Выключен</option><option value="local">На этом сервере</option><option value="remote">На другом сервере</option></select></label>
          {settings.voiceMode === 'remote' && <label>Адрес Voice API<input type="url" value={settings.voiceExternalUrl} onChange={(event) => setSettings({ ...settings, voiceExternalUrl: event.target.value })} placeholder="https://voice.example.com/api/voice" /></label>}
          <label>Токен Voice <SecretState configured={settings.hasVoiceToken} /><input type="password" value={voiceToken} onChange={(event) => setVoiceToken(event.target.value)} autoComplete="off" placeholder="Для локального режима создастся автоматически" /></label>
          <p className="muted">Первый запуск локального Voice может занять несколько минут: Docker скачивает и собирает модели.</p>
        </section>

        <div className="actionRow"><p className="muted">{saveState}</p><button type="submit" disabled={saving}>{saving ? 'Применяю…' : 'Сохранить и применить'}</button></div>
      </form>

      <details className="card accountCard">
        <summary>Сменить логин и пароль</summary>
        <form className="stack compactStack" onSubmit={changeAccount}>
          <label>Новый логин<input value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>Текущий пароль<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label>
          <label>Новый пароль (минимум 12 символов)<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
          <button type="submit" className="secondary">Сменить данные</button><p className="muted">{accountState}</p>
        </form>
      </details>
    </main>
  );
}

function Brand() {
  return <div className="brand"><span className="brandDot" /> Chatter</div>;
}
