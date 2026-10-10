import { and, eq } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { badRequest, notFound } from '../../shared/errors.js';

export type StoreContext = {
  id: string;
  slug: string;
  name: string;
  vertical: string;
  defaultLocale: string;
  defaultCurrency: string;
  locales: { code: string; name: string; direction: string }[];
  currencies: { code: string; name: string; minorUnits: number }[];
};

export async function getActiveStore(db: Database, slug: string): Promise<StoreContext> {
  const [store] = await db
    .select()
    .from(s.stores)
    .where(and(eq(s.stores.slug, slug), eq(s.stores.status, 'active')));
  if (!store) throw notFound('Store');

  const [locales, currencies] = await Promise.all([
    db
      .select({ code: s.locales.code, name: s.locales.name, direction: s.locales.direction })
      .from(s.storeLocales)
      .innerJoin(s.locales, eq(s.locales.code, s.storeLocales.locale))
      .where(eq(s.storeLocales.storeId, store.id)),
    db
      .select({ code: s.currencies.code, name: s.currencies.name, minorUnits: s.currencies.minorUnits })
      .from(s.storeCurrencies)
      .innerJoin(s.currencies, eq(s.currencies.code, s.storeCurrencies.currency))
      .where(eq(s.storeCurrencies.storeId, store.id)),
  ]);

  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    vertical: store.vertical,
    defaultLocale: store.defaultLocale,
    defaultCurrency: store.defaultCurrency,
    locales,
    currencies,
  };
}

/** Returns the requested locale if the store supports it, else the store default when none was requested. */
export function resolveLocale(store: StoreContext, requested?: string): string {
  if (!requested) return store.defaultLocale;
  if (!store.locales.some((l) => l.code === requested)) {
    throw badRequest('UNSUPPORTED_LOCALE', `Locale "${requested}" is not available in this store`);
  }
  return requested;
}

export function resolveCurrency(store: StoreContext, requested?: string) {
  const code = requested?.toUpperCase() ?? store.defaultCurrency;
  const currency = store.currencies.find((c) => c.code === code);
  if (!currency) throw badRequest('UNSUPPORTED_CURRENCY', `Currency "${code}" is not available in this store`);
  return currency;
}
