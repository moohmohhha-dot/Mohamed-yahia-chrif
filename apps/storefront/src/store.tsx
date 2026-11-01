/**
 * Shopper state kept in the browser: the cart (offers and quantities, with what is needed to show it)
 * and the signed-in account. Prices are always re-read from the server at checkout.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, storage, tokenStore, type User } from './api';

export type CartLine = { offerId: string; productSlug: string; names: Record<string, string>; name: string; brand: string | null; sizeMl: number | null; unitPriceMinor: number; merchant: string; quantity: number; hue: number };

type Shop = {
  cart: CartLine[];
  count: number;
  subtotalMinor: number;
  add: (line: Omit<CartLine, 'quantity'>, quantity?: number) => void;
  setQuantity: (offerId: string, quantity: number) => void;
  clear: () => void;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (displayName: string, email: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Products picked for comparison (2 to 4). */
  compare: string[];
  toggleCompare: (slug: string) => void;
  /** A short message after an action ("Added to cart"). */
  toast: string | null;
  notify: (message: string) => void;
};
const Ctx = createContext<Shop | null>(null);
const CART_KEY = 'mbp.cart';
const USER_KEY = 'mbp.user';
const COMPARE_KEY = 'mbp.compare';

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(storage.get(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

export function ShopProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartLine[]>(() => read(CART_KEY, []));
  const [user, setUser] = useState<User | null>(() => (tokenStore.get() ? read(USER_KEY, null) : null));
  const [toast, setToast] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>(() => read(COMPARE_KEY, []));
  useEffect(() => storage.set(COMPARE_KEY, JSON.stringify(compare)), [compare]);
  useEffect(() => storage.set(CART_KEY, JSON.stringify(cart)), [cart]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const session = useCallback((data: { user: User; token: string }) => {
    tokenStore.set(data.token);
    storage.set(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  const value = useMemo<Shop>(
    () => ({
      cart,
      count: cart.reduce((n, l) => n + l.quantity, 0),
      subtotalMinor: cart.reduce((n, l) => n + l.quantity * l.unitPriceMinor, 0),
      add: (line, quantity = 1) =>
        setCart((c) => {
          const found = c.find((l) => l.offerId === line.offerId);
          return found ? c.map((l) => (l.offerId === line.offerId ? { ...l, quantity: Math.min(10, l.quantity + quantity) } : l)) : [...c, { ...line, quantity }];
        }),
      setQuantity: (offerId, quantity) => setCart((c) => (quantity <= 0 ? c.filter((l) => l.offerId !== offerId) : c.map((l) => (l.offerId === offerId ? { ...l, quantity: Math.min(10, quantity) } : l)))),
      clear: () => setCart([]),
      user,
      signIn: async (email, password) => session(await api('POST', '/v1/auth/login', { email, password })),
      register: async (displayName, email, password) => session(await api('POST', '/v1/auth/register', { email, password, displayName })),
      signOut: () => {
        void api('POST', '/v1/auth/logout').catch(() => {});
        tokenStore.set(null);
        storage.set(USER_KEY, null);
        setUser(null);
      },
      compare,
      toggleCompare: (slug) => setCompare((c) => (c.includes(slug) ? c.filter((x) => x !== slug) : [...c, slug].slice(-4))),
      toast,
      notify: setToast,
    }),
    [cart, user, toast, session, compare],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShop() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useShop outside ShopProvider');
  return ctx;
}

/** Loads data for a page; `reload` runs it again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(() => {
    setError(null);
    return load().then(setData, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setData(null);
    void run();
  }, [run]);
  return { data, error, reload: run };
}
