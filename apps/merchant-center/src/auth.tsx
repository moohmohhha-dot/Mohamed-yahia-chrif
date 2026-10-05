import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api';

export type User = { id: string; email: string; displayName: string };
type Auth = {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string, locale: string) => Promise<void>;
  logout: () => Promise<void>;
};
const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const clear = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    if (!tokenStore.get()) return setReady(true);
    api<User>('GET', '/v1/me')
      .then(setUser)
      .catch(clear)
      .finally(() => setReady(true));
  }, [clear]);

  const signedIn = (data: { token: string; user: User }) => {
    tokenStore.set(data.token);
    setUser(data.user);
  };

  return (
    <Ctx.Provider
      value={{
        user,
        ready,
        login: async (email, password) => signedIn(await api('POST', '/v1/auth/login', { email, password })),
        register: async (email, password, displayName, locale) =>
          signedIn(await api('POST', '/v1/auth/register', { email, password, displayName, locale })),
        logout: async () => {
          await api('POST', '/v1/auth/logout').catch(() => undefined);
          clear();
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
