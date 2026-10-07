import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthorizedHandler, tokenStore } from './api';

/** ARUMA staff member, with the permissions their roles give (the server checks them again on every call). */
export type Staff = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  mfa: { required: boolean; enabled: boolean; sessionVerified: boolean; recoveryCodesLeft: number };
};
type Auth = {
  staff: Staff | null;
  /** Signed in, but not ARUMA staff. */
  notStaff: boolean;
  /** Password accepted; waiting for the authenticator code. */
  awaitingCode: boolean;
  ready: boolean;
  can: (...permissions: string[]) => boolean;
  login: (email: string, password: string) => Promise<void>;
  verifyCode: (code: string) => Promise<void>;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
};
const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [notStaff, setNotStaff] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const clear = useCallback(() => {
    tokenStore.set(null);
    setStaff(null);
    setChallenge(null);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setStaff(await api<Staff>('GET', '/v1/admin/me'));
      setNotStaff(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setNotStaff(true);
      else clear();
    }
  }, [clear]);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    if (!tokenStore.get()) return setReady(true);
    void loadMe().finally(() => setReady(true));
  }, [clear, loadMe]);

  const value: Auth = {
    staff,
    notStaff,
    awaitingCode: challenge !== null,
    ready,
    can: (...permissions) => Boolean(staff && permissions.some((p) => staff.permissions.includes(p))),
    login: async (email, password) => {
      const data = await api<{ token?: string; mfaRequired?: boolean; challengeToken?: string }>('POST', '/v1/auth/login', { email, password });
      if (data.mfaRequired) return setChallenge(data.challengeToken!);
      tokenStore.set(data.token!);
      await loadMe();
    },
    verifyCode: async (code) => {
      const data = await api<{ token: string }>('POST', '/v1/auth/mfa', { challengeToken: challenge, code });
      setChallenge(null);
      tokenStore.set(data.token);
      await loadMe();
    },
    reload: loadMe,
    logout: async () => {
      await api('POST', '/v1/auth/logout').catch(() => undefined);
      clear();
      setNotStaff(false);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
