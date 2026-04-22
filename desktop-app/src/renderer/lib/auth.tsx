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
      // Validate token by making a request
      api.getChats().then(() => {
        // Token valid — but we don't have user info from this endpoint
        // Store user info in localStorage on login, restore here
        const stored = localStorage.getItem('chatter_user');
        if (stored) {
          try { setUser(JSON.parse(stored)); } catch {}
        } else {
          setUser({ id: 0, name: null, username: null, role: 'user', is_admin: 0, plan: 'free' });
        }
        setInitialized(true);
      }).catch(() => {
        api.clearTokens();
        setInitialized(true);
      });
    } else {
      setInitialized(true);
    }
  }, []);

  const loginAndSet = useCallback(async (login: string, password: string) => {
    const res = await api.login(login, password);
    setUser(res.user);
    localStorage.setItem('chatter_user', JSON.stringify(res.user));
    return res;
  }, []);

  const registerAndSet = useCallback(async (login: string, password: string, name?: string) => {
    const res = await api.register(login, password, name);
    setUser(res.user);
    localStorage.setItem('chatter_user', JSON.stringify(res.user));
    return res;
  }, []);

  const logoutFn = useCallback(() => {
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
