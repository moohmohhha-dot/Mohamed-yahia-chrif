import { api } from '../api';
import type { Locale } from '../i18n';

export type Translation = { locale: string; name: string; description: string | null };
export type Offer = {
  id: string;
  variantId: string;
  status: 'active' | 'archived';
  stockQuantity: number;
  sku: string;
  options: Record<string, unknown>;
  storeSlug: string;
  product: { id: string; slug: string; names: Record<string, string> };
  prices: { currency: string; amountMinor: number; compareAtMinor: number | null }[];
};
export type Product = {
  id: string;
  slug: string;
  storeSlug: string;
  status: 'draft' | 'active' | 'archived';
  ownedByMe: boolean;
  attributes: Record<string, any>;
  categories: string[];
  translations: Translation[];
  variants: {
    id: string;
    sku: string;
    options: Record<string, any>;
    isActive: boolean;
    myOffer: { id: string; status: string; stock: number } | null;
  }[];
};
export type StoreInfo = {
  slug: string;
  name: string;
  defaultLocale: string;
  defaultCurrency: string;
  locales: { code: string; name: string }[];
  currencies: { code: string; minorUnits: number }[];
};

/** Picks a name in the UI language, else any available one. */
export function nameIn(names: Record<string, string> | Translation[], locale: Locale): string {
  const map = Array.isArray(names) ? Object.fromEntries(names.map((t) => [t.locale, t.name])) : names;
  return map[locale] ?? Object.values(map)[0] ?? '—';
}

export const sizeLabel = (options: Record<string, unknown>) => (options.sizeMl ? `${options.sizeMl} ml` : '');

const storeCache = new Map<string, Promise<StoreInfo>>();
export function loadStore(slug: string) {
  if (!storeCache.has(slug)) storeCache.set(slug, api<StoreInfo>('GET', `/v1/stores/${slug}`));
  return storeCache.get(slug)!;
}
