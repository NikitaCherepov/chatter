'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AdminShell, type AdminSection } from '../components/AdminShell';
import { LoginScreen } from '../components/LoginScreen';
import { IntegrationsPage } from '../components/pages/IntegrationsPage';
import { LogsPage } from '../components/pages/LogsPage';
import { ModelsPage } from '../components/pages/ModelsPage';
import { OverviewPage } from '../components/pages/OverviewPage';
import { PlaceholderPage } from '../components/pages/PlaceholderPage';
import { SecurityPage } from '../components/pages/SecurityPage';
import { ServicesPage } from '../components/pages/ServicesPage';
import { api } from '../lib/api';
import { emptySettings, type Service, type Settings } from '../lib/types';

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [section, setSection] = useState<AdminSection>('overview');
  const [username, setUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [services, setServices] = useState<Service[]>([]);
  const [telegramToken, setTelegramToken] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [voiceToken, setVoiceToken] = useState('');
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
      setSaveState('Настройки применены.');
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

  if (authenticated === null) return <main className="loadingScreen"><div className="loader" /></main>;

  if (!authenticated) {
    return <LoginScreen username={username} password={loginPassword} error={loginError} onUsernameChange={setUsername} onPasswordChange={setLoginPassword} onSubmit={login} />;
  }

  const sharedSettingsProps = { settings, setSettings, saving, saveState, onSave: save };

  return (
    <AdminShell section={section} username={username} services={services} onSectionChange={setSection} onLogout={logout}>
      {section === 'overview' && <OverviewPage services={services} settings={settings} onRefresh={loadData} onNavigate={setSection} />}
      {section === 'models' && <ModelsPage {...sharedSettingsProps} apiKey={aiApiKey} onApiKeyChange={setAiApiKey} />}
      {section === 'integrations' && <IntegrationsPage settings={settings} onNavigate={setSection} />}
      {section === 'services' && <ServicesPage {...sharedSettingsProps} services={services} telegramToken={telegramToken} voiceToken={voiceToken} onTelegramTokenChange={setTelegramToken} onVoiceTokenChange={setVoiceToken} />}
      {section === 'users' && <PlaceholderPage title="Пользователи" description="Управление аккаунтами, ролями и привязками появится здесь." />}
      {section === 'limits' && <PlaceholderPage title="Тарифы и лимиты" description="Общие тарифы и индивидуальные ограничения пользователей будут собраны в одном месте." />}
      {section === 'system' && <PlaceholderPage title="Система" description="Ресурсы сервера, версии компонентов, обновления и резервные копии появятся здесь." />}
      {section === 'logs' && <LogsPage />}
      {section === 'security' && <SecurityPage username={username} currentPassword={currentPassword} newPassword={newPassword} state={accountState} onUsernameChange={setUsername} onCurrentPasswordChange={setCurrentPassword} onNewPasswordChange={setNewPassword} onSubmit={changeAccount} />}
    </AdminShell>
  );
}
