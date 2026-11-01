import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storage } from './api';
import { MESSAGES, NOTE_NAMES } from './messages';

export type Locale = 'ar' | 'fr' | 'en';
export type MessageKey = keyof typeof MESSAGES;
export const LOCALES: { code: Locale; label: string; dir: 'rtl' | 'ltr' }[] = [
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'en', label: 'English', dir: 'ltr' },
];
const INDEX: Record<Locale, 0 | 1 | 2> = { ar: 0, fr: 1, en: 2 };

type I18n = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** A key built from data (a category slug, a status…), with a fallback when it has no text. */
  tx: (key: string, fallback: MessageKey) => string;
  /** Prices: DZD shown as "8 500 د.ج" / "8 500 DA". */
  money: (amountMinor: number, currency?: string) => string;
  date: (iso: string) => string;
  note: (word: string) => string;
  /** Bottle size: "50 مل" / "50 ml". */
  ml: (n: number) => string;
};
const Ctx = createContext<I18n | null>(null);

function initial(): Locale {
  const saved = storage.get('mbp.locale');
  return saved === 'ar' || saved === 'fr' || saved === 'en' ? saved : 'ar';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALES.find((l) => l.code === locale)!.dir;
  }, [locale]);
  const value = useMemo<I18n>(() => {
    const i = INDEX[locale];
    const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-DZ-u-nu-latn' : locale === 'fr' ? 'fr-DZ' : 'en-US', { maximumFractionDigits: 0 });
    return {
      locale,
      setLocale: (l) => {
        storage.set('mbp.locale', l);
        setLocaleState(l);
      },
      t: (key, vars) => (MESSAGES[key]?.[i] ?? key).replace(/\{(\w+)\}/g, (_, n) => String(vars?.[n] ?? `{${n}}`)),
      tx: (key, fallback) => (key in MESSAGES ? MESSAGES[key as MessageKey][i] : MESSAGES[fallback][i]),
      money: (minor, currency = 'DZD') => {
        const amount = number.format(minor / 100);
        if (currency !== 'DZD') return `${amount} ${currency}`;
        return locale === 'ar' ? `${amount} د.ج` : `${amount} DA`;
      },
      date: (iso) => new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar-DZ-u-nu-latn' : locale, { day: 'numeric', month: 'long', year: 'numeric' }),
      note: (word) => NOTE_NAMES[word.toLowerCase()]?.[i] ?? word,
      ml: (n) => (locale === 'ar' ? `${n} مل` : `${n} ml`),
    };
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
