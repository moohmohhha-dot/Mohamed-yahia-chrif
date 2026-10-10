import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { ar } from './ar';
import { en, type Messages } from './en';
import { fr } from './fr';

export type Locale = 'ar' | 'fr' | 'en';
export type MessageKey = keyof Messages;
const dictionaries: Record<Locale, Messages> = { ar, fr, en };
export const LOCALES: { code: Locale; label: string; dir: 'rtl' | 'ltr' }[] = [
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'en', label: 'English', dir: 'ltr' },
];

type I18n = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** A translated message for an API error code, falling back to the server's message. */
  errorText: (error: unknown) => string;
};
const Ctx = createContext<I18n | null>(null);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('aruma.locale');
    if (saved === 'ar' || saved === 'fr' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'ar';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  useEffect(() => {
    const dir = LOCALES.find((l) => l.code === locale)!.dir;
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const dict = dictionaries[locale];
    const t: I18n['t'] = (key, vars) =>
      (dict[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? `{${name}}`));
    return {
      locale,
      setLocale: (l) => {
        setLocaleState(l);
        try {
          localStorage.setItem('aruma.locale', l);
        } catch {
          /* ignore */
        }
      },
      t,
      errorText: (error) => {
        if (error instanceof ApiError) {
          const key = `err.${error.code}` as MessageKey;
          return key in dict ? t(key) : error.message;
        }
        return error instanceof Error ? error.message : String(error);
      },
    };
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
