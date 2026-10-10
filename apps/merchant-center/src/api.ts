/** Thin client for ARUMA CORE. Every rule is enforced by the server; the UI only mirrors it. */
const TOKEN_KEY = 'aruma.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string | null) => (token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY)),
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => void (onUnauthorized = fn);

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-client-platform': 'web' };
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, json.error?.code ?? 'ERROR', json.error?.message ?? res.statusText);
  }
  return json.data as T;
}

/** Downloads a protected file (documents need the bearer token, so a plain link won't do). */
export async function download(path: string, fileName: string) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${tokenStore.get()}` } });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
}

/** Integer minor units ⇄ decimal string, e.g. 850000 ⇄ "8500.00" for 2 minor units. */
export const money = {
  format: (amountMinor: number, currency: string, locale: string, minorUnits = 2) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minorUnits }).format(
      amountMinor / 10 ** minorUnits,
    ),
  toMinor: (amount: string, minorUnits = 2) => Math.round(Number(amount.replace(',', '.')) * 10 ** minorUnits),
  fromMinor: (amountMinor: number, minorUnits = 2) => (amountMinor / 10 ** minorUnits).toFixed(minorUnits),
};
