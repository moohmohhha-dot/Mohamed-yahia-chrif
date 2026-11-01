/**
 * Client for ARUMA CORE. In the demo build the same calls are answered by a sample catalog running in
 * the browser (src/demo/server.ts); pages never know the difference.
 */
declare const __DEMO__: boolean;
export const DEMO = __DEMO__;
export const STORE = 'mb-parfum';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** localStorage can be missing or throw (private windows, embedded viewers): the shop works without it. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* not available */
    }
  },
};

const TOKEN_KEY = 'mbp.token';
export const tokenStore = { get: () => storage.get(TOKEN_KEY), set: (t: string | null) => storage.set(TOKEN_KEY, t) };

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  // The demo catalog is loaded only in the demo build (dead code, removed, in the normal build).
  if (DEMO) return (await import('./demo/server')).demoApi<T>(method, path, body, tokenStore.get());
  const h: Record<string, string> = { 'x-client-platform': 'web', ...headers };
  const token = tokenStore.get();
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) tokenStore.set(null);
    throw new ApiError(res.status, json.error?.code ?? 'ERROR', json.error?.message ?? res.statusText);
  }
  return json.data as T;
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();

// --- Shapes returned by ARUMA CORE ----------------------------------------------------------------------

export type Money = { currency: string; amountMinor: number; amount: string };
export type Card = {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  image: { url: string; alt?: string | null } | null;
  priceFrom: Money;
  rating: { average: number | null; count: number };
  inStock: boolean;
  sellers: number;
  attributes: Record<string, any>;
};
export type Category = { id: string; slug: string; parentId: string | null; name: string };
export type SearchResult = {
  query: { text: string; words: string[]; correctedFrom: string | null; suggestion: string | null; understood: { kind: string; value: string | number; phrase: string }[]; sort: string };
  results: Card[];
  facets: {
    brands: { slug: string; name: string; count: number }[];
    categories: { slug: string; name: string; count: number }[];
    merchants: { slug: string; name: string; count: number }[];
    price: { minMinor: number | null; maxMinor: number | null };
    gender: { value: string; count: number }[];
  };
  meta: { total: number; page: number; pageSize: number; totalPages: number };
};
export type Suggestions = { queries: string[]; completions: string[]; products: { slug: string; name: string }[]; brands: { slug: string; name: string }[]; categories: { slug: string; name: string }[] };
export type Variant = { id: string; sku: string; options: { sizeMl?: number }; inStock: boolean; price: Money | null; compareAtPrice: Money | null; offer: { id: string; merchant: { slug: string; name: string } } | null; offerCount: number };
export type Product = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  brand: { slug: string; name: string } | null;
  attributes: { gender?: string; concentration?: string; notes?: { top?: string[]; heart?: string[]; base?: string[] } };
  categories: string[];
  images: { url: string; alt: string | null }[];
  rating: { count: number; average: number | null; distribution: Record<string, number> };
  variants: Variant[];
};
export type Review = { id: string; rating: number; title: string | null; body: string | null; author: string; verifiedPurchase: boolean; seller: string; helpfulCount: number; merchantReply: { text: string; at: string } | null; publishedAt: string };
export type ReviewSummary = { count: number; average: number | null; distribution: Record<string, number>; summary: { summary: string; pros: string[]; cons: string[]; generatedByAi: true } | null };
export type Recommendations = { similar: Card[]; boughtTogether: Card[]; bundle: { basis: string; items: Card[]; total: Money } | null };
export type Area = { id: string; level: string; parentId: string | null; names: Record<string, string> };
export type DeliveryOption = { methodId: string; type: string; name: string; courierName: string | null; priceMinor: number; free: boolean; freeAboveMinor: number | null; minDays: number; maxDays: number; cashOnDelivery: boolean; pickupLocation: { address: string; hours?: string } | null };
export type DeliveryOptions = { currency: string; sellers: { merchantId: string; merchantName: string; subtotalMinor: number; options: DeliveryOption[] }[]; unavailableOfferIds: string[] };
export type Order = {
  id: string;
  number: string;
  checkoutId: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  shippingMinor: number;
  totalMinor: number;
  paymentMethod: string;
  placedAt: string;
  merchant: { name: string; slug: string };
  shippingAddress: { fullName: string; phone: string; city: string; region: string; line1: string };
  delivery: { name: string; minDays: number; maxDays: number } | null;
  cod: { confirmationStatus: string; amountDueMinor: number } | null;
  shipment: { trackingNumber?: string | null; status?: string } | null;
  lines: { id: string; offerId: string; sku: string; productNames: Record<string, string>; options: { sizeMl?: number }; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  history: { id: string; toStatus: string; createdAt: string; reason: string | null }[];
  allowedTransitions: { to: string }[];
};
export type Checkout = { checkoutId: string; orders: Order[]; cod: { confirmationRequired: boolean; codeSent: boolean; sentTo?: string } | null };
export type AiState = { assistant: boolean; comparisonSummary: boolean; reviewSummaries: boolean; giftUnderstanding: boolean; naturalLanguageSearch: boolean };
export type User = { id: string; email: string; displayName: string };
