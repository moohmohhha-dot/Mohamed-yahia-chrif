import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { MESSAGES } from './messages';

export type Locale = 'ar' | 'fr' | 'en';
export type MessageKey = keyof typeof MESSAGES;
const INDEX: Record<Locale, 0 | 1 | 2> = { en: 0, fr: 1, ar: 2 };
export const LOCALES: { code: Locale; label: string; dir: 'rtl' | 'ltr' }[] = [
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'en', label: 'English', dir: 'ltr' },
];

type I18n = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** For values coming from the API (statuses, reasons…): translated when known, readable otherwise. */
  label: (prefix: string, value: string | null | undefined) => string;
  errorText: (error: unknown) => string;
  money: (amountMinor: number | null | undefined, currency: string, minorUnits?: number) => string;
  date: (value: string | Date | null | undefined, withTime?: boolean) => string;
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
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALES.find((l) => l.code === locale)!.dir;
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const i = INDEX[locale];
    const lookup = (key: string) => (MESSAGES as Record<string, readonly [string, string, string]>)[key]?.[i];
    const t: I18n['t'] = (key, vars) => (lookup(key) ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? `{${name}}`));
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
      label: (prefix, value) => (value ? lookup(`${prefix}.${value}`) ?? value.replace(/_/g, ' ') : '—'),
      errorText: (error) => {
        if (error instanceof ApiError) return lookup(`err.${error.code}`) ?? error.message;
        return error instanceof Error ? error.message : String(error);
      },
      money: (amountMinor, currency, minorUnits = 2) =>
        amountMinor === null || amountMinor === undefined
          ? '—'
          : new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minorUnits }).format(amountMinor / 10 ** minorUnits),
      date: (value, withTime = true) => (value ? (withTime ? new Date(value).toLocaleString(locale) : new Date(value).toLocaleDateString(locale)) : '—'),
    };
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
