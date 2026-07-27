import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { ForcePasswordChangePage } from './pages/ForcePasswordChangePage';
import { useAuth, AuthProvider } from './lib/auth';
import * as api from './lib/api';
import { getUnseenAnnouncements } from './lib/announcements';
import { UpdateModal } from './components/UpdateModal';
import { OnboardingModal } from './components/OnboardingModal';
import { CustomTitleBar } from './components/CustomTitleBar';
import s from './App.module.scss';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const { t } = useTranslation();

  if (!initialized) {
    return <div className={s.loading}>{t('common.loading')}</div>;
  }

  if (!user) return <Navigate to="/login" replace />;
  // Force password change after admin reset or recovery via Telegram bot.
  if (user.must_change_password) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const { t } = useTranslation();

  if (!initialized) {
    return <div className={s.loading}>{t('common.loading')}</div>;
  }

  return user ? <Navigate to="/chat" replace /> : <>{children}</>;
}

function ChangePasswordRoute() {
  const { user, initialized } = useAuth();
  const { t } = useTranslation();

  if (!initialized) {
    return <div className={s.loading}>{t('common.loading')}</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!user.must_change_password) return <Navigate to="/chat" replace />;
  return <ForcePasswordChangePage />;
}

export function App() {
  return (
    <AuthProvider>
      <div className={s.appShell}>
        <CustomTitleBar />
        <div className={s.appContent}>
          <HashRouter>
            <Routes>
              <Route
                path="/login"
                element={
                  <PublicRoute>
                    <AuthPage />
                  </PublicRoute>
                }
              />
              <Route
                path="/change-password"
                element={<ChangePasswordRoute />}
              />
              <Route
                path="/chat"
                element={
                  <PrivateRoute>
                    <ChatPage />
                  </PrivateRoute>
                }
              />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </HashRouter>
        </div>
      </div>
      <Toaster position="top-right" richColors closeButton offset={52} />
      <AnnouncementOverlay />
      <UpdateListener />
    </AuthProvider>
  );
}

/** Shows announcements (welcome, feature releases) the user hasn't seen yet.
 *  Only renders when the user is authenticated and initialized. */
function AnnouncementOverlay() {
  const { user, initialized } = useAuth();
  const [visible, setVisible] = useState(true);
  const prevUserIdRef = useRef<number | null>(null);

  // Reset visibility when a different user logs in.
  useEffect(() => {
    const userId = user?.id ?? null;
    if (userId !== prevUserIdRef.current) {
      prevUserIdRef.current = userId;
      setVisible(true);
    }
  }, [user?.id]);

  const unseen = useMemo(
    () => (user ? getUnseenAnnouncements(user.ui_settings) : []),
    [user],
  );

  const handleDone = useCallback(
    async (seenIds: string[]) => {
      try {
        const existing = user?.ui_settings?.seen_announcements ?? [];
        const merged = [...new Set([...existing, ...seenIds])];
        await api.setUiSettings({ seen_announcements: merged });
      } catch {
        // If saving fails, show again next time.
      }
      setVisible(false);
    },
    [user],
  );

  if (!initialized || !user || unseen.length === 0 || !visible) return null;

  return (
    <AnimatePresence>
      <OnboardingModal
        key="onboarding"
        announcements={unseen}
        onDone={handleDone}
      />
    </AnimatePresence>
  );
}

/** Listens for auto-check updates from main process and shows modal */
function UpdateListener() {
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    releaseNotes: string;
    size: number;
  } | null>(null);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    return api.onUpdateAvailable((info: any) => {
      setUpdateInfo(info);
    });
  }, []);

  if (!updateInfo) return null;

  return (
    <UpdateModal
      info={updateInfo}
      onClose={() => setUpdateInfo(null)}
    />
  );
}
