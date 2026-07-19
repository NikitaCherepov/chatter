import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as api from './api';

type UserInfo = api.AuthResponse['user'];

type AuthContextValue = {
  user: UserInfo | null;
  initialized: boolean;
  setUser: (user: UserInfo | null) => void;
  loginAndSet: (login: string, password: string) => Promise<api.AuthResponse>;
  registerAndSet: (login: string, password: string, name?: string) => Promise<api.AuthResponse>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const tokens = api.loadTokens();
    if (tokens?.access_token) {
      api.fetchMe()
        .then((user) => {
          setUser(user);
          localStorage.setItem('chatter_user', JSON.stringify(user));
          // Initialize WebSocket after successful auth
          api.initWebSocket();
        })
        .catch((error) => {
          if (error instanceof api.ApiError && error.status === 401) {
            api.clearTokens();
            localStorage.removeItem('chatter_user');
            setUser(null);
            return;
          }
          // A temporary network error should not sign the user out.
          const stored = localStorage.getItem('chatter_user');
          if (stored) {
            try { setUser(JSON.parse(stored)); } catch {}
          }
        })
        .finally(() => setInitialized(true));
    } else {
      setInitialized(true);
    }

    // Close WebSocket on unmount
    return () => {
      api.closeWebSocket();
    };
  }, []);

  const loginAndSet = useCallback(async (login: string, password: string) => {
    const res = await api.login(login, password);
    setUser(res.user);
    localStorage.setItem('chatter_user', JSON.stringify(res.user));
    // Initialize WebSocket after login
    api.initWebSocket();
    return res;
  }, []);

  const registerAndSet = useCallback(async (login: string, password: string, name?: string) => {
    const res = await api.register(login, password, name);
    setUser(res.user);
    localStorage.setItem('chatter_user', JSON.stringify(res.user));
    // Initialize WebSocket after registration
    api.initWebSocket();
    return res;
  }, []);

  const logoutFn = useCallback(() => {
    api.closeWebSocket();
    api.logout();
    setUser(null);
    localStorage.removeItem('chatter_user');
  }, []);

  return (
    <AuthContext.Provider value={{ user, initialized, setUser, loginAndSet, registerAndSet, logout: logoutFn }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
