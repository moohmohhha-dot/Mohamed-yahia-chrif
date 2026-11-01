/**
 * Demo build only: answers the storefront's API calls from the sample catalogue, in the browser, with
 * the same shapes as ARUMA CORE. Accounts and orders are kept in this browser (localStorage). Orders
 * advance on their own (processing → preparing → shipping → delivered) so the tracking can be seen.
 */
import { ApiError, storage, type Area, type Card, type Order, type Product } from '../api';
import { NOTE_NAMES } from '../messages';
import { BOUGHT_TOGETHER, BRANDS, CATEGORIES, PRODUCTS, SELLERS, type DemoProduct } from './data';
import geo from './geo.json';

type Locale = 'ar' | 'fr' | 'en';
const LOC = (l: string | null | undefined): Locale => (l === 'fr' || l === 'en' ? l : 'ar');
const DAY = 86_400_000;
const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 120 + Math.random() * 160));
const fail = (status: number, code: string, message: string) => new ApiError(status, code, message);

// --- Text matching (same idea as the real search: no accents, no diacritics, no article) ----------------
const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const stripArticle = (w: string) => w.replace(/^(?:[وفبكل]?ال|لل)(?=\p{L}{3,})/u, '');
const STOP = new Set(['de', 'la', 'le', 'les', 'du', 'des', 'un', 'une', 'et', 'pour', 'the', 'a', 'for', 'and', 'of', 'with', 'avec', 'عطر', 'parfum', 'perfume', 'في', 'من', 'مع', 'على']);
const words = (s: string) => norm(s).split(' ').map(stripArticle).filter((w) => w && !STOP.has(w));
const SYNONYMS = [
  ['عود', 'oud'],
  ['مسك', 'musc', 'musk'],
  ['عنبر', 'ambre', 'amber'],
  ['ورد', 'ورده', 'rose'],
  ['ياسمين', 'jasmin', 'jasmine'],
  ['فانيليا', 'vanille', 'vanilla'],
  ['زعفران', 'safran', 'saffron'],
  ['خشب', 'خشبي', 'bois', 'boise', 'wood', 'woody'],
  ['زهري', 'floral', 'fleur', 'flower'],
  ['منعش', 'frais', 'fresh'],
  ['شرقي', 'oriental'],
  ['قهوه', 'cafe', 'coffee'],
  ['نعناع', 'menthe', 'mint'],
  ['تين', 'figue', 'fig'],
];
const expand = (w: string) => SYNONYMS.find((g) => g.includes(w)) ?? [w];

function haystack(p: DemoProduct) {
  const notes = [...p.notes.top, ...p.notes.heart, ...p.notes.base].flatMap((n) => [n, ...(NOTE_NAMES[n] ?? [])]);
  const cat = CATEGORIES.find((c) => c.slug === p.category)!;
  return words([...Object.values(p.name), BRANDS[p.brand], ...Object.values(cat.name), ...notes, ...Object.values(p.description)].join(' '));
}
const HAY = new Map(PRODUCTS.map((p) => [p.slug, haystack(p)]));
const VOCAB = [...new Set([...HAY.values()].flat())];
const matches = (p: DemoProduct, ws: string[]) => ws.every((w) => expand(w).some((alt) => HAY.get(p.slug)!.some((h) => h === alt || (alt.length >= 3 && h.startsWith(alt)))));

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
const correct = (w: string) => VOCAB.filter((v) => Math.abs(v.length - w.length) <= 2).sort((a, b) => lev(w, a) - lev(w, b))[0];

// --- Catalogue views ---------------------------------------------------------------------------------
const minPrice = (p: DemoProduct) => Math.min(...p.variants.map((v) => v.price)) * 100;
const rating = (p: DemoProduct) => ({ average: p.reviews.length ? Math.round((p.reviews.reduce((n, r) => n + r.rating, 0) / p.reviews.length) * 100) / 100 : null, count: p.reviews.length });
const money = (minor: number) => ({ currency: 'DZD', amountMinor: minor, amount: (minor / 100).toFixed(2) });
const card = (p: DemoProduct, l: Locale): Card => ({
  id: `demo-${p.slug}`,
  slug: p.slug,
  name: p.name[l],
  brand: BRANDS[p.brand]!,
  image: null,
  priceFrom: money(minPrice(p)),
  rating: rating(p),
  inStock: p.variants.some((v) => v.stock > 0),
  sellers: 1 + (p.alsoSoldBy?.length ?? 0),
  attributes: { gender: p.gender, concentration: p.concentration.toLowerCase() === 'parfum' ? 'parfum' : p.concentration.toLowerCase() },
});
const bySlug = (slug: string) => {
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (!p) throw fail(404, 'NOT_FOUND', 'Product not found');
  return p;
};
const offerOf = (p: DemoProduct, ml: number) => `demo-${p.slug}-${ml}`;
function findOffer(offerId: string) {
  for (const p of PRODUCTS) for (const v of p.variants) if (offerOf(p, v.ml) === offerId) return { p, v };
  return null;
}

/** Search sentences: "عطر رجالي أقل من 9000 دج", "parfum femme moins de 8000". */
function understand(text: string) {
  const out: { priceMax?: number; gender?: string; understood: { kind: string; value: string | number; phrase: string }[] } = { understood: [] };
  let rest = norm(text);
  const price = rest.match(/(?:اقل من|اقل|حتي|moins de|max|under|below|less than)\s*(\d[\d ]*)\s*(?:الف|k|mille)?/);
  if (price) {
    const n = Number(price[1]!.replace(/ /g, '')) * (/الف|k|mille/.test(price[0]) ? 1000 : 1);
    out.priceMax = n;
    out.understood.push({ kind: 'priceMax', value: n, phrase: price[0] });
    rest = rest.replace(price[0], ' ');
  }
  const g = [
    // \b does not see Arabic letters as word characters: match whole words by spaces instead.
    ['men', /(?<=^|\s)(رجالي|للرجال|رجال|homme|hommes|men|man|masculin)(?=\s|$)/],
    ['women', /(?<=^|\s)(نسايي|نساييه|للنساء|نساء|femme|femmes|women|woman|feminin)(?=\s|$)/],
  ] as const;
  for (const [gender, re] of g) {
    const m = rest.match(re);
    if (m) {
      out.gender = gender;
      out.understood.push({ kind: 'gender', value: gender, phrase: m[0] });
      rest = rest.replace(m[0], ' ');
    }
  }
  return { ...out, text: rest.replace(/(?<=^|\s)(دج|da|dzd|dinars?)(?=\s|$)/g, ' ') };
}

function search(params: URLSearchParams) {
  const l = LOC(params.get('locale'));
  const raw = params.get('q') ?? '';
  const nl = raw ? understand(raw) : { text: '', understood: [] as { kind: string; value: string | number; phrase: string }[], priceMax: undefined, gender: undefined };
  let ws = words(nl.text);
  const gender = params.get('gender') || nl.gender;
  const priceMax = Number(params.get('priceMax') || nl.priceMax || 0);
  const filtered = (list: string[]) =>
    PRODUCTS.filter(
      (p) =>
        (!params.get('category') || p.category === params.get('category')) &&
        (!params.get('brand') || p.brand === params.get('brand')) &&
        (!gender || p.gender === gender) &&
        (!priceMax || minPrice(p) <= priceMax * 100) &&
        (params.get('inStock') !== 'true' || p.variants.some((v) => v.stock > 0)) &&
        matches(p, list),
    );
  let list = filtered(ws);
  let correctedFrom: string | null = null;
  if (!list.length && ws.length) {
    const fixed = ws.map((w) => (VOCAB.includes(w) ? w : (correct(w) ?? w)));
    const retry = filtered(fixed);
    if (retry.length) {
      correctedFrom = ws.join(' ');
      ws = fixed;
      list = retry;
    }
  }
  const sort = params.get('sort') || (ws.length ? 'relevance' : 'popular');
  const order: Record<string, (a: DemoProduct, b: DemoProduct) => number> = {
    relevance: (a, b) => b.popularity - a.popularity,
    popular: (a, b) => b.popularity - a.popularity,
    price_asc: (a, b) => minPrice(a) - minPrice(b),
    price_desc: (a, b) => minPrice(b) - minPrice(a),
    rating: (a, b) => (rating(b).average ?? 0) - (rating(a).average ?? 0),
    newest: (a, b) => a.daysOld - b.daysOld,
  };
  list = [...list].sort(order[sort] ?? order.popular);
  const pageSize = Number(params.get('pageSize') || 24);
  const page = Number(params.get('page') || 1);
  const count = <K extends string>(key: (p: DemoProduct) => K) => {
    const m = new Map<K, number>();
    for (const p of list) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return [...m.entries()];
  };
  return {
    query: { text: raw, words: ws, correctedFrom, suggestion: null, understood: nl.understood, sort },
    results: list.slice((page - 1) * pageSize, page * pageSize).map((p) => card(p, l)),
    facets: {
      brands: count((p) => p.brand).map(([slug, n]) => ({ slug, name: BRANDS[slug]!, count: n })),
      categories: count((p) => p.category).map(([slug, n]) => ({ slug, name: CATEGORIES.find((c) => c.slug === slug)!.name[l], count: n })),
      merchants: count((p) => p.seller).map(([slug, n]) => ({ slug, name: SELLERS[slug]!, count: n })),
      price: { minMinor: list.length ? Math.min(...list.map(minPrice)) : null, maxMinor: list.length ? Math.max(...list.map(minPrice)) : null },
      gender: count((p) => p.gender).map(([value, n]) => ({ value, count: n })),
      rating: { atLeast4: 0, atLeast3: 0 },
    },
    meta: { total: list.length, page, pageSize, totalPages: Math.max(1, Math.ceil(list.length / pageSize)), locale: l, currency: 'DZD' },
  };
}

function product(p: DemoProduct, l: Locale): Product {
  const r = rating(p);
  return {
    id: `demo-${p.slug}`,
    slug: p.slug,
    name: p.name[l],
    description: p.description[l],
    brand: { slug: p.brand, name: BRANDS[p.brand]! },
    attributes: { gender: p.gender, concentration: p.concentration, notes: p.notes },
    categories: [p.category],
    images: [],
    rating: { count: r.count, average: r.average, distribution: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, p.reviews.filter((x) => x.rating === n).length])) },
    variants: p.variants.map((v) => ({
      id: `${p.slug}-${v.ml}`,
      sku: `${p.slug}-${v.ml}`.toUpperCase(),
      options: { sizeMl: v.ml },
      inStock: v.stock > 0,
      price: money(v.price * 100),
      compareAtPrice: v.compareAt ? money(v.compareAt * 100) : null,
      offer: { id: offerOf(p, v.ml), merchant: { slug: p.seller, name: SELLERS[p.seller]! } },
      offerCount: 1 + (p.alsoSoldBy?.length ?? 0),
    })),
  };
}

function similar(p: DemoProduct, l: Locale, n = 8) {
  const score = (o: DemoProduct) =>
    (o.category === p.category ? 3 : 0) + (o.brand === p.brand ? 2 : 0) + (o.gender === p.gender ? 2 : 0) + [...o.notes.top, ...o.notes.heart, ...o.notes.base].filter((x) => [...p.notes.top, ...p.notes.heart, ...p.notes.base].includes(x)).length - Math.abs(Math.log(minPrice(o) / minPrice(p)));
  return PRODUCTS.filter((o) => o.slug !== p.slug).sort((a, b) => score(b) - score(a)).slice(0, n).map((o) => card(o, l));
}

// --- Accounts and orders (this browser only) -------------------------------------------------------------
type DemoUser = { id: string; email: string; displayName: string; password: string };
type DemoOrder = Omit<Order, 'status' | 'history' | 'allowedTransitions'> & { createdAt: number; confirmedAt: number | null; cancelledAt: number | null; userId: string };
const load = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(storage.get(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => storage.set(key, JSON.stringify(value));
// Without storage (private windows), keep data for the visit in memory.
const memory: Record<string, unknown> = {};
const users = (): DemoUser[] => load('mbp.demo.users', (memory.users as DemoUser[]) ?? []);
const setUsers = (u: DemoUser[]) => ((memory.users = u), save('mbp.demo.users', u));
const orders = (): DemoOrder[] => load('mbp.demo.orders', (memory.orders as DemoOrder[]) ?? []);
const setOrders = (o: DemoOrder[]) => ((memory.orders = o), save('mbp.demo.orders', o));
const tokens = (): Record<string, string> => load('mbp.demo.tokens', (memory.tokens as Record<string, string>) ?? {});
const userOf = (token: string | null) => {
  const id = token ? tokens()[token] : undefined;
  const user = users().find((u) => u.id === id);
  if (!user) throw fail(401, 'UNAUTHORIZED', 'Sign in first');
  return user;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
function session(user: DemoUser) {
  const token = `demo_${uid()}`;
  const t = { ...tokens(), [token]: user.id };
  memory.tokens = t;
  save('mbp.demo.tokens', t);
  return { user: { id: user.id, email: user.email, displayName: user.displayName }, token };
}

/** Orders move forward with time, as if the seller and courier were working. */
const STEPS = [
  ['processing', 0],
  ['preparing', 2 * 60_000],
  ['shipping', 5 * 60_000],
  ['delivered', 10 * 60_000],
] as const;
function view(o: DemoOrder): Order {
  const history: Order['history'] = [{ id: `${o.id}-0`, toStatus: 'new', createdAt: new Date(o.createdAt).toISOString(), reason: null }];
  let status = 'new';
  if (o.cancelledAt) {
    status = 'cancelled';
    history.push({ id: `${o.id}-x`, toStatus: 'cancelled', createdAt: new Date(o.cancelledAt).toISOString(), reason: null });
  } else if (o.confirmedAt) {
    for (const [s, after] of STEPS) {
      if (Date.now() >= o.confirmedAt + after) {
        status = s;
        history.push({ id: `${o.id}-${s}`, toStatus: s, createdAt: new Date(o.confirmedAt + after).toISOString(), reason: null });
      }
    }
  }
  return {
    ...o,
    status,
    history,
    shipment: status === 'shipping' || status === 'delivered' ? { trackingNumber: `YAL-${o.number.slice(-6)}`, status } : null,
    cod: o.cod ? { ...o.cod, confirmationStatus: o.confirmedAt ? 'confirmed' : 'pending' } : null,
    allowedTransitions: status === 'new' || status === 'processing' ? [{ to: 'cancelled' }] : [],
  };
}

const ZONE_PRICE = (wilaya: string) => (wilaya === 'DZ-16' ? 400 : ['DZ-01', 'DZ-08', 'DZ-11', 'DZ-30', 'DZ-33', 'DZ-37', 'DZ-39', 'DZ-47', 'DZ-49', 'DZ-50', 'DZ-52', 'DZ-53', 'DZ-54', 'DZ-55', 'DZ-56', 'DZ-57', 'DZ-58'].includes(wilaya) ? 1000 : 650);
const AREAS = (geo as [string, string, string, string][]).map(([id, parentId, ar, fr]) => ({ id, parentId: parentId || null, names: { ar, fr, en: fr } }));
const wilayaOf = (localityId: string) => localityId.slice(0, 5);

function deliveryOptions(lines: { offerId: string; quantity: number }[], localityId?: string) {
  const bySeller = new Map<string, number>();
  const unavailable: string[] = [];
  for (const l of lines) {
    const f = findOffer(l.offerId);
    if (!f || f.v.stock < l.quantity) unavailable.push(l.offerId);
    else bySeller.set(f.p.seller, (bySeller.get(f.p.seller) ?? 0) + f.v.price * 100 * l.quantity);
  }
  const wilaya = localityId ? wilayaOf(localityId) : '';
  return {
    currency: 'DZD',
    unavailableOfferIds: unavailable,
    sellers: [...bySeller.entries()].map(([seller, subtotal]) => {
      const home = ZONE_PRICE(wilaya) * 100;
      const free = subtotal >= 1_500_000;
      const options = [
        { methodId: `${seller}-home`, type: 'courier', name: 'Yalidine', courierName: 'Yalidine Express', priceMinor: free ? 0 : home, free, freeAboveMinor: 1_500_000, minDays: wilaya === 'DZ-16' ? 1 : 2, maxDays: wilaya === 'DZ-16' ? 2 : 5, cashOnDelivery: true, pickupLocation: null },
        { methodId: `${seller}-desk`, type: 'pickup_point', name: 'Stop desk', courierName: 'Yalidine Stop Desk', priceMinor: free ? 0 : Math.round(home * 0.6), free, freeAboveMinor: 1_500_000, minDays: 2, maxDays: 4, cashOnDelivery: true, pickupLocation: null },
      ];
      if (seller === 'mb-parfum' && wilaya === 'DZ-16') options.push({ methodId: 'mb-parfum-shop', type: 'local_pickup', name: 'Retrait en boutique', courierName: null as unknown as string, priceMinor: 0, free: true, freeAboveMinor: 0, minDays: 0, maxDays: 0, cashOnDelivery: true, pickupLocation: { address: '12 rue Didouche Mourad, Alger Centre', hours: 'Sam–Jeu 10:00–19:00' } as never });
      return { merchantId: seller, merchantName: SELLERS[seller]!, subtotalMinor: subtotal, options };
    }),
  };
}

// --- AI-like answers of the demo (the real shop uses the AI layer when ARUMA switches it on) -------------
const T = (l: Locale, ar: string, fr: string, en: string) => ({ ar, fr, en })[l];

function compare(slugs: string[], l: Locale) {
  const list = [...new Set(slugs)].map(bySlug);
  if (list.length < 2) throw fail(400, 'COMPARE_COUNT', 'Compare 2 to 4 products');
  const rows = list.map((p) => ({
    product: card(p, l),
    sizes: p.variants.map((v) => ({ sizeMl: v.ml, price: money(v.price * 100), per100ml: money(Math.round((v.price * 100 * 100) / v.ml)), inStock: v.stock > 0 })),
    notes: p.notes,
    gender: p.gender,
    concentration: p.concentration.toLowerCase(),
  }));
  const perMl = (p: DemoProduct) => Math.min(...p.variants.map((v) => v.price / v.ml));
  const cheapest = [...list].sort((a, b) => minPrice(a) - minPrice(b))[0]!;
  const value = [...list].sort((a, b) => perMl(a) - perMl(b))[0]!;
  const rated = [...list].filter((p) => p.reviews.length >= 2).sort((a, b) => (rating(b).average ?? 0) - (rating(a).average ?? 0))[0];
  const strongest = [...list].sort((a, b) => ['EDC', 'EDT', 'EDP', 'Parfum'].indexOf(b.concentration) - ['EDC', 'EDT', 'EDP', 'Parfum'].indexOf(a.concentration))[0]!;
  return {
    products: rows,
    highlights: { cheapest: cheapest.slug, bestValue: value.slug, bestRated: rated?.slug ?? null, inStock: list.filter((p) => p.variants.some((v) => v.stock > 0)).map((p) => p.slug) },
    summary: {
      summary: T(
        l,
        `${cheapest.name.ar} هو الأقل سعرًا، و${value.name.ar} الأوفر لكل 100 مل. أما ${strongest.name.ar} فهو الأقوى تركيزًا والأطول ثباتًا، ويناسب المساء أكثر.`,
        `${cheapest.name.fr} est le moins cher et ${value.name.fr} le plus avantageux aux 100 ml. ${strongest.name.fr} est le plus concentré, avec la meilleure tenue : plutôt pour le soir.`,
        `${cheapest.name.en} is the cheapest and ${value.name.en} the best value per 100 ml. ${strongest.name.en} is the most concentrated and lasts longest — better for evenings.`,
      ),
      bestFor: list.map((p) => ({
        slug: p.slug,
        reason: p.category === 'fresh' ? T(l, 'النهار والصيف', 'La journée et l’été', 'Daytime and summer') : p.category === 'oriental' || p.concentration === 'Parfum' ? T(l, 'السهرات والمناسبات', 'Le soir et les occasions', 'Evenings and occasions') : p.category === 'gourmand' ? T(l, 'الشتاء', 'L’hiver', 'Winter') : T(l, 'كل يوم', 'Tous les jours', 'Every day'),
      })),
      generatedByAi: true,
    },
  };
}

function giftIdeas(body: { forWhom?: string; gender?: string; budgetMax?: number; locale?: string }) {
  const l = LOC(body.locale);
  const nl = understand(body.forWhom ?? '');
  const text = norm(body.forWhom ?? '');
  const forWomen = /(ام|امي|والدتي|زوجتي|اختي|ابنتي|خطيبتي|maman|mere|epouse|femme|soeur|fille|copine|collegue|mother|mom|wife|sister|daughter|girlfriend)/.test(text);
  const forMen = /(ابي|والدي|زوجي|اخي|ابني|خطيبي|papa|pere|mari|frere|fils|copain|father|dad|husband|brother|son|boyfriend)/.test(text);
  const gender = body.gender || nl.gender || (forWomen ? 'women' : forMen ? 'men' : undefined);
  const budgetMax = body.budgetMax ?? nl.priceMax;
  const likes = words(nl.text).filter((w) => VOCAB.includes(w) || SYNONYMS.some((g) => g.includes(w))).filter((w) => !/^(ام|امي|ابي|pere|mere|maman|papa)$/.test(w)).slice(0, 4);
  const pool = PRODUCTS.filter((p) => (!gender || p.gender === gender || p.gender === 'unisex') && (!budgetMax || minPrice(p) <= budgetMax * 100) && p.variants.some((v) => v.stock > 0));
  const liked = pool.filter((p) => likes.some((w) => matches(p, [w])));
  const rest = pool.filter((p) => !liked.includes(p)).sort((a, b) => b.popularity - a.popularity);
  return { understood: { gender, budgetMax, likes }, source: 'ai', relaxed: likes.length > 0 && liked.length === 0, products: [...liked, ...rest].slice(0, 8).map((p) => card(p, l)) };
}

function assistant(body: { messages: { role: string; content: string }[]; locale?: string }) {
  const l = LOC(body.locale);
  const question = body.messages[body.messages.length - 1]?.content ?? '';
  const isGift = /هديه|هدية|cadeau|gift|offrir/i.test(question);
  const r = isGift ? giftIdeas({ forWhom: question, locale: l }) : null;
  const found = r ? r.products : search(new URLSearchParams({ q: question, locale: l, pageSize: '4' })).results;
  const list = found.length ? found : search(new URLSearchParams({ sort: 'popular', locale: l, pageSize: '3' })).results;
  const names = list.slice(0, 3).map((p) => p.name).join(T(l, '، ', ', ', ', '));
  const reply = found.length
    ? T(l, `اخترت لك: ${names}. كلها متوفرة ويمكن الدفع عند الاستلام. هل تريد أن أقارن بينها؟`, `Je vous propose : ${names}. Tous sont en stock, avec paiement à la livraison. Voulez-vous que je les compare ?`, `I suggest: ${names}. All in stock, with cash on delivery. Shall I compare them?`)
    : T(l, `لم أجد طلبك بالضبط، لكن هذه الأكثر مبيعًا: ${names}.`, `Je n’ai pas trouvé exactement, mais voici nos meilleures ventes : ${names}.`, `I could not find that exactly, but here are our best sellers: ${names}.`);
  return { reply, products: list.slice(0, 4), tools: ['search_products'], generatedByAi: true };
}

// --- Router -----------------------------------------------------------------------------------------------
export async function demoApi<T>(method: string, path: string, body: any, token: string | null): Promise<T> {
  const url = new URL(path, 'https://demo.local');
  const p = url.searchParams;
  const l = LOC(p.get('locale') ?? body?.locale);
  const route = `${method} ${url.pathname}`;
  let m: RegExpMatchArray | null;
  const ok = (v: unknown) => delay(v as T);

  if (route === 'GET /v1/stores/mb-parfum') return ok({ id: 'demo', slug: 'mb-parfum', name: 'MB Parfum', defaultLocale: 'ar', defaultCurrency: 'DZD' });
  if (route === 'GET /v1/stores/mb-parfum/ai') return ok({ assistant: true, comparisonSummary: true, reviewSummaries: true, giftUnderstanding: true, naturalLanguageSearch: true });
  if (route === 'GET /v1/stores/mb-parfum/categories') return ok(CATEGORIES.map((c) => ({ id: c.slug, slug: c.slug, parentId: null, name: c.name[l] })));
  if (route === 'GET /v1/stores/mb-parfum/search') return ok(search(p));
  if (route === 'GET /v1/stores/mb-parfum/search/suggest') {
    const q = words(p.get('q') ?? '');
    const last = q[q.length - 1] ?? '';
    return ok({
      queries: [],
      completions: VOCAB.filter((v) => last && v.startsWith(last) && v !== last).slice(0, 3).map((v) => [...q.slice(0, -1), v].join(' ')),
      products: PRODUCTS.filter((x) => last && Object.values(x.name).some((n) => words(n).some((w) => w.startsWith(last)))).slice(0, 4).map((x) => ({ slug: x.slug, name: x.name[l] })),
      brands: Object.entries(BRANDS).filter(([, n]) => last && norm(n).includes(last)).map(([slug, name]) => ({ slug, name })),
      categories: CATEGORIES.filter((c) => last && Object.values(c.name).some((n) => norm(n).startsWith(last))).map((c) => ({ slug: c.slug, name: c.name[l] })),
    });
  }
  if ((m = route.match(/^GET \/v1\/stores\/mb-parfum\/products\/([^/]+)$/))) return ok(product(bySlug(m[1]!), l));
  if ((m = route.match(/^GET \/v1\/stores\/mb-parfum\/products\/([^/]+)\/recommendations$/))) {
    const prod = bySlug(m[1]!);
    const together = (BOUGHT_TOGETHER[prod.slug] ?? []).map(bySlug).map((x) => card(x, l));
    const items = [card(prod, l), ...(together.length ? together.slice(0, 2) : similar(prod, l, 1))];
    const total = items.reduce((n, x) => n + x.priceFrom.amountMinor, 0);
    return ok({ similar: similar(prod, l), boughtTogether: together, bundle: { basis: together.length ? 'bought_together' : 'same_brand', items, total: money(total) } });
  }
  if ((m = route.match(/^GET \/v1\/stores\/mb-parfum\/products\/([^/]+)\/review-summary$/))) {
    const prod = bySlug(m[1]!);
    const r = rating(prod);
    return ok({
      product: { id: `demo-${prod.slug}`, slug: prod.slug },
      count: r.count,
      average: r.average,
      distribution: Object.fromEntries([5, 4, 3, 2, 1].map((n) => [n, prod.reviews.filter((x) => x.rating === n).length])),
      summary: prod.summary && prod.reviews.length >= 3 ? { summary: prod.summary.summary[l], pros: prod.summary.pros.map((x) => x[l]), cons: prod.summary.cons.map((x) => x[l]), basedOn: prod.reviews.length, generatedByAi: true } : null,
    });
  }
  if ((m = route.match(/^GET \/v1\/products\/demo-([^/]+)\/reviews$/))) {
    const prod = bySlug(m[1]!);
    const lang = LOC(storage.get('mbp.locale'));
    return ok({
      reviews: [...prod.reviews].sort((a, b) => a.daysAgo - b.daysAgo).map((x, i) => ({ id: `${prod.slug}-r${i}`, rating: x.rating, title: null, body: x.body[lang], author: x.author, verifiedPurchase: true, seller: SELLERS[prod.seller]!, helpfulCount: 0, merchantReply: x.reply ? { text: x.reply[lang], at: new Date(Date.now() - (x.daysAgo - 1) * DAY).toISOString() } : null, publishedAt: new Date(Date.now() - x.daysAgo * DAY).toISOString() })),
    });
  }
  if (route === 'GET /v1/stores/mb-parfum/compare') return ok(compare((p.get('products') ?? '').split(',').filter(Boolean), l));
  if (route === 'POST /v1/stores/mb-parfum/gift-ideas') return ok(giftIdeas(body ?? {}));
  if (route === 'POST /v1/stores/mb-parfum/assistant') return ok(assistant(body));
  if (route === 'GET /v1/geo/DZ/areas') {
    const parent = p.get('parentId');
    return ok(AREAS.filter((a) => a.parentId === (parent || null)).map((a): Area => ({ id: a.id, level: parent ? (parent.includes('-D-') ? 'locality' : 'district') : 'region', parentId: a.parentId, names: a.names })));
  }
  if (route === 'POST /v1/stores/mb-parfum/delivery-options') return ok(deliveryOptions(body.lines, body.localityId));

  if (route === 'POST /v1/auth/register') {
    const email = String(body.email).trim().toLowerCase();
    if (String(body.password).length < 10) throw fail(400, 'WEAK_PASSWORD', 'At least 10 characters');
    if (users().some((u) => u.email === email)) throw fail(409, 'EMAIL_TAKEN', 'Email already registered');
    const user = { id: uid(), email, displayName: String(body.displayName).trim(), password: String(body.password) };
    setUsers([...users(), user]);
    return ok(session(user));
  }
  if (route === 'POST /v1/auth/login') {
    const user = users().find((u) => u.email === String(body.email).trim().toLowerCase() && u.password === body.password);
    if (!user) throw fail(401, 'INVALID_CREDENTIALS', 'Wrong email or password');
    return ok(session(user));
  }
  if (route === 'POST /v1/auth/logout') return ok(undefined);

  if (route === 'POST /v1/stores/mb-parfum/orders') {
    const user = userOf(token);
    const options = deliveryOptions(body.lines, body.shippingAddress.localityId);
    if (options.unavailableOfferIds.length) throw fail(409, 'OUT_OF_STOCK', 'Some items are no longer available');
    const area = AREAS.find((a) => a.id === body.shippingAddress.localityId);
    const region = AREAS.find((a) => a.id === wilayaOf(body.shippingAddress.localityId));
    const checkoutId = uid();
    const all = orders();
    const created: DemoOrder[] = options.sellers.map((s, i) => {
      const method = s.options.find((o) => o.methodId === body.delivery.find((d: { merchantId: string }) => d.merchantId === s.merchantId)?.methodId) ?? s.options[0]!;
      const lines = body.lines
        .map((line: { offerId: string; quantity: number }) => ({ line, f: findOffer(line.offerId)! }))
        .filter((x: { f: { p: DemoProduct } }) => x.f.p.seller === s.merchantId)
        .map((x: { line: { offerId: string; quantity: number }; f: { p: DemoProduct; v: DemoProduct['variants'][number] } }) => ({ id: uid(), offerId: x.line.offerId, sku: `${x.f.p.slug}-${x.f.v.ml}`.toUpperCase(), productNames: x.f.p.name, options: { sizeMl: x.f.v.ml }, quantity: x.line.quantity, unitPriceMinor: x.f.v.price * 100, lineTotalMinor: x.f.v.price * 100 * x.line.quantity }));
      const subtotal = lines.reduce((n: number, x: { lineTotalMinor: number }) => n + x.lineTotalMinor, 0);
      const phone = String(body.shippingAddress.phone).replace(/\D/g, '').replace(/^0/, '+213');
      return {
        id: uid(),
        number: `2026-${String(100 + all.length + i + 1).padStart(6, '0')}`,
        checkoutId,
        merchantId: s.merchantId,
        currency: 'DZD',
        subtotalMinor: subtotal,
        shippingMinor: method.priceMinor,
        totalMinor: subtotal + method.priceMinor,
        paymentMethod: 'cash_on_delivery',
        placedAt: new Date().toISOString(),
        merchant: { name: s.merchantName, slug: s.merchantId },
        shippingAddress: { fullName: body.shippingAddress.fullName, phone, city: area?.names[l] ?? '', region: region?.names[l] ?? '', line1: body.shippingAddress.line1 },
        delivery: { name: method.courierName ?? method.name, minDays: method.minDays, maxDays: method.maxDays },
        cod: { confirmationStatus: 'pending', amountDueMinor: subtotal + method.priceMinor },
        shipment: null,
        lines,
        createdAt: Date.now(),
        confirmedAt: null,
        cancelledAt: null,
        userId: user.id,
      };
    });
    setOrders([...all, ...created]);
    const phone = String(body.shippingAddress.phone).replace(/\D/g, '');
    return ok({ checkoutId, orders: created.map(view), payment: null, cod: { confirmationRequired: true, codeSent: true, sentTo: `+213••••${phone.slice(-2)}` } });
  }
  if ((m = route.match(/^POST \/v1\/me\/checkouts\/([^/]+)\/cod\/confirm$/))) {
    const user = userOf(token);
    if (!/^\d{6}$/.test(String(body?.code ?? ''))) throw fail(400, 'INVALID_CODE', 'Six digits');
    setOrders(orders().map((o) => (o.checkoutId === m![1] && o.userId === user.id ? { ...o, confirmedAt: Date.now() } : o)));
    return ok({ confirmed: true });
  }
  if (route === 'GET /v1/me/orders') {
    const user = userOf(token);
    return ok(orders().filter((o) => o.userId === user.id).sort((a, b) => b.createdAt - a.createdAt).map(view));
  }
  if ((m = route.match(/^GET \/v1\/me\/orders\/([^/]+)$/))) {
    const user = userOf(token);
    const o = orders().find((x) => x.id === m![1] && x.userId === user.id);
    if (!o) throw fail(404, 'NOT_FOUND', 'Order not found');
    return ok(view(o));
  }
  if ((m = route.match(/^POST \/v1\/me\/orders\/([^/]+)\/cancel$/))) {
    const user = userOf(token);
    const o = orders().find((x) => x.id === m![1] && x.userId === user.id);
    if (!o || !view(o).allowedTransitions.length) throw fail(409, 'INVALID_TRANSITION', 'This order can no longer be cancelled');
    setOrders(orders().map((x) => (x.id === o.id ? { ...x, cancelledAt: Date.now() } : x)));
    return ok(view({ ...o, cancelledAt: Date.now() }));
  }
  throw fail(404, 'NOT_FOUND', `Demo: ${route} is not available`);
}
