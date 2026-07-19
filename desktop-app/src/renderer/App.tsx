import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { useAuth, AuthProvider } from './lib/auth';
import { UpdateModal } from './components/UpdateModal';
import { CustomTitleBar } from './components/CustomTitleBar';
import s from './App.module.scss';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const { t } = useTranslation();

  if (!initialized) {
    return <div className={s.loading}>{t('common.loading')}</div>;
  }

  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const { t } = useTranslation();

  if (!initialized) {
    return <div className={s.loading}>{t('common.loading')}</div>;
  }

  return user ? <Navigate to="/chat" replace /> : <>{children}</>;
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
      <UpdateListener />
    </AuthProvider>
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
