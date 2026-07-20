'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AdminShell, type AdminSection } from '../components/AdminShell/AdminShell';
import { LoginScreen } from '../components/LoginScreen/LoginScreen';
import { IntegrationsPage } from '../components/pages/IntegrationsPage/IntegrationsPage';
import { LogsPage } from '../components/pages/LogsPage/LogsPage';
import { ModelsPage } from '../components/pages/ModelsPage/ModelsPage';
import { OverviewPage } from '../components/pages/OverviewPage/OverviewPage';
import { PlaceholderPage } from '../components/pages/PlaceholderPage/PlaceholderPage';
import { SecurityPage } from '../components/pages/SecurityPage/SecurityPage';
import { ServicesPage } from '../components/pages/ServicesPage/ServicesPage';
import { SystemPage } from '../components/pages/SystemPage/SystemPage';
import { UserDetailPage } from '../components/pages/UserDetailPage/UserDetailPage';
import { UsersPage } from '../components/pages/UsersPage/UsersPage';
import { AccessKeysPage } from '../components/pages/AccessKeysPage/AccessKeysPage';
import { PlanLimitsPage } from '../components/pages/PlanLimitsPage/PlanLimitsPage';
import { api, ApiError } from '../lib/api';
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
  const [voiceToken, setVoiceToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [accountState, setAccountState] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

  useEffect(() => {
    const syncUserRoute = () => {
      const match = window.location.pathname.match(/^\/users\/(\d+)\/?$/);
      const userId = match ? Number.parseInt(match[1], 10) : null;
      setSelectedUserId(userId && userId > 0 ? userId : null);
      if (userId) setSection('users');
    };
    syncUserRoute();
    window.addEventListener('popstate', syncUserRoute);
    return () => window.removeEventListener('popstate', syncUserRoute);
  }, []);

  const loadData = useCallback(async () => {
    const [loadedSettings, status, session] = await Promise.all([
      api<Settings>('/api/settings'),
      api<{ services: Service[] }>('/api/status'),
      api<{ username: string }>('/api/session'),
    ]);
    const loadedServices = status.services || [];
    const isRunning = (serviceName: string) =>
      loadedServices.some((service) => service.service === serviceName && service.state === 'running');
    setSettings({
      ...emptySettings,
      ...loadedSettings,
      telegramEnabled: isRunning('telegram-bot'),
      notesEnabled: isRunning('webapp-notes'),
    });
    setServices(loadedServices);
    setUsername(session.username);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const checkSession = (attempt = 0) => {
      api<{ authenticated: boolean; username: string }>('/api/session')
        .then(async (session) => {
          if (cancelled) return;
          setAuthenticated(true);
          setUsername(session.username);
          await loadData();
        })
        .catch(error => {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 401) {
            setAuthenticated(false);
            return;
          }
          if (attempt < 15) retryTimer = window.setTimeout(() => checkSession(attempt + 1), 2000);
          else setAuthenticated(false);
        });
    };
    checkSession();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [loadData]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setLoginError('');
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password: loginPassword }),
      });
      setLoginPassword('');
      setAuthenticated(true);
      await loadData();
    } catch (error) {
      setLoginError(
        error instanceof Error && error.message === 'invalid_credentials'
          ? 'Неверный логин или пароль.'
          : String(error),
      );
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
        body: JSON.stringify({ ...settings, telegramToken, voiceToken }),
      });
      setTelegramToken('');
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
      await api('/api/account', {
        method: 'PUT',
        body: JSON.stringify({ username, currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setAccountState('Изменено. Войди снова.');
      setTimeout(() => setAuthenticated(false), 700);
    } catch (error) {
      setAccountState(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (authenticated === null)
    return (
      <main className="loadingScreen">
        <div className="loader" />
      </main>
    );

  if (!authenticated) {
    return (
      <LoginScreen
        username={username}
        password={loginPassword}
        error={loginError}
        onUsernameChange={setUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={login}
      />
    );
  }

  const sharedSettingsProps = { settings, setSettings, saving, saveState, onSave: save };

  function navigateSection(nextSection: AdminSection) {
    if (selectedUserId || window.location.pathname.startsWith('/users/')) {
      window.history.pushState({}, '', '/');
      setSelectedUserId(null);
    }
    setSection(nextSection);
  }

  function openUser(userId: number) {
    window.history.pushState({}, '', `/users/${userId}`);
    setSelectedUserId(userId);
    setSection('users');
  }

  function closeUser() {
    window.history.pushState({}, '', '/');
    setSelectedUserId(null);
    setSection('users');
  }

  return (
    <AdminShell
      section={section}
      username={username}
      services={services}
      onSectionChange={navigateSection}
      onLogout={logout}
    >
      {section === 'overview' && (
        <OverviewPage
          services={services}
          settings={settings}
          onRefresh={loadData}
          onNavigate={navigateSection}
        />
      )}
      {section === 'models' && <ModelsPage {...sharedSettingsProps} />}
      {section === 'integrations' && (
        <IntegrationsPage {...sharedSettingsProps} onNavigate={navigateSection} />
      )}
      {section === 'services' && (
        <ServicesPage
          {...sharedSettingsProps}
          services={services}
          telegramToken={telegramToken}
          voiceToken={voiceToken}
          onTelegramTokenChange={setTelegramToken}
          onVoiceTokenChange={setVoiceToken}
        />
      )}
      {section === 'users' && selectedUserId && <UserDetailPage userId={selectedUserId} onBack={closeUser} />}
      {section === 'users' && !selectedUserId && <UsersPage onSelectUser={openUser} />}
      {section === 'accessKeys' && <AccessKeysPage />}
      {section === 'limits' && <PlanLimitsPage />}
      {section === 'system' && <SystemPage />}
      {section === 'logs' && <LogsPage />}
      {section === 'security' && (
        <SecurityPage
          username={username}
          currentPassword={currentPassword}
          newPassword={newPassword}
          state={accountState}
          onUsernameChange={setUsername}
          onCurrentPasswordChange={setCurrentPassword}
          onNewPasswordChange={setNewPassword}
          onSubmit={changeAccount}
        />
      )}
    </AdminShell>
  );
}
