import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Kv, Loading, Pager, ReasonAction, Tabs, useLoad } from '../components/ui';
import { useI18n, type Locale } from '../i18n';

const PAGE = 50;
const nameIn = (names: Record<string, string>, locale: Locale) => names[locale] ?? names.fr ?? names.ar ?? names.en ?? Object.values(names)[0] ?? '—';
type Product = {
  id: string;
  slug: string;
  storeSlug: string;
  merchantId: string | null;
  merchantName: string | null;
  names: Record<string, string>;
  status: string;
  blocked: { at: string; reason: string } | null;
  offers: number;
  availableStock: number;
  updatedAt: string;
};
type Offer = {
  id: string;
  sku: string;
  status: string;
  merchantName: string;
  productNames: Record<string, string>;
  options: Record<string, unknown>;
  storeSlug: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number | null;
  prices: { currency: string; amountMinor: number }[];
};

export function ProductsPage() {
  const { t, locale, date } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'' | 'active' | 'draft' | 'archived' | 'blocked'>('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE), ...(search ? { q: search } : {}), ...(filter === 'blocked' ? { blocked: 'true' } : filter ? { status: filter } : {}) });
  const list = useLoad(() => api<Product[]>('GET', `/v1/admin/products?${qs}`), [qs.toString(), selected]);
  if (selected) return <ProductDetail productId={selected} onBack={() => setParams({})} />;
  return (
    <>
      <h1>{t('section.products')}</h1>
      <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => (e.preventDefault(), setPage(1), setSearch(q.trim()))}>
        <input style={{ maxWidth: 320 }} placeholder={t('products.search')} aria-label={t('products.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary">{t('common.search')}</button>
      </form>
      <Tabs value={filter} options={['active', 'draft', 'archived', 'blocked'] as const} onChange={(v) => (setFilter(v), setPage(1))} prefix="productStatus" allLabel="common.all" />
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('products.merchant')}</th>
                <th className="num">{t('products.offers')}</th>
                <th className="num">{t('products.stock')}</th>
                <th>{t('common.status')}</th>
                <th>{t('products.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button className="link" onClick={() => setParams({ id: p.id })}>
                      {nameIn(p.names, locale)}
                    </button>
                    <div className="muted small">
                      {p.storeSlug} · {p.slug}
                    </div>
                  </td>
                  <td>{p.merchantName ?? '—'}</td>
                  <td className="num">{p.offers}</td>
                  <td className="num">{p.availableStock}</td>
                  <td>{p.blocked ? <Badge prefix="productStatus" value="blocked" /> : <Badge prefix="productStatus" value={p.status} />}</td>
                  <td className="small">{date(p.updatedAt, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} count={list.data.length} pageSize={PAGE} />
        </Card>
      )}
    </>
  );
}

type ProductDetailData = {
  id: string;
  slug: string;
  storeSlug: string;
  merchantName: string | null;
  status: string;
  attributes: Record<string, unknown>;
  blocked: { at: string; reason: string; previousStatus: string } | null;
  translations: { locale: string; name: string; description: string | null }[];
  variants: { id: string; sku: string; options: Record<string, unknown>; isActive: boolean }[];
  offers: Offer[];
  history: { action: string; actorName: string | null; metadata: Record<string, unknown>; createdAt: string }[];
};

function ProductDetail({ productId, onBack }: { productId: string; onBack: () => void }) {
  const { t, label, date } = useI18n();
  const { can } = useAuth();
  const url = `/v1/admin/products/${productId}`;
  const product = useLoad(() => api<ProductDetailData>('GET', url), [url]);
  if (product.error) return <ErrorBox error={product.error} />;
  if (!product.data) return <Loading />;
  const p = product.data;
  const reload = () => void product.reload();
  return (
    <>
      <div className="topbar">
        <h1 className="row">
          {p.translations[0]?.name ?? p.slug} {p.blocked ? <Badge prefix="productStatus" value="blocked" /> : <Badge prefix="productStatus" value={p.status} />}
        </h1>
        <button className="link" onClick={onBack}>
          {t('products.back')}
        </button>
      </div>
      {p.blocked && (
        <div className="alert alert-bad" data-testid="blocked">
          {t('products.blockedSince', { date: date(p.blocked.at) })} — {p.blocked.reason}
        </div>
      )}
      {can('catalog.moderate') && (
        <Card title={t('products.moderation')}>
          {p.blocked ? (
            <ReasonAction label={t('products.unblock')} onConfirm={(reason) => api('POST', `${url}/unblock`, { reason }).then(reload)} />
          ) : (
            <ReasonAction label={t('products.block')} danger onConfirm={(reason) => api('POST', `${url}/block`, { reason }).then(reload)} />
          )}
          <p className="muted small">{t('products.blockHint')}</p>
        </Card>
      )}
      <div className="split">
        <Card title={t('products.details')}>
          <Kv
            rows={[
              [t('products.store'), p.storeSlug],
              [t('products.merchant'), p.merchantName],
              ...p.translations.map((tr) => [tr.locale.toUpperCase(), <>{tr.name}{tr.description && <div className="muted small">{tr.description}</div>}</>] as [string, ReactNode]),
              [t('products.variants'), p.variants.map((v) => v.sku).join(', ')],
            ]}
          />
        </Card>
        <Card title={t('products.history')}>
          {p.history.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {p.history.map((h, i) => (
                  <tr key={i}>
                    <td className="small">{date(h.createdAt)}</td>
                    <td className="small">{label('auditAction', h.action)}</td>
                    <td className="small">{h.actorName}</td>
                    <td className="small muted">{String(h.metadata.reason ?? h.metadata.note ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title={t('section.offers')}>
        <OfferTable offers={p.offers} />
      </Card>
    </>
  );
}

function OfferTable({ offers }: { offers: Offer[] }) {
  const { t, locale, money } = useI18n();
  if (offers.length === 0) return <Empty />;
  return (
    <table>
      <thead>
        <tr>
          <th>{t('offers.sku')}</th>
          <th>{t('products.merchant')}</th>
          <th className="num">{t('offers.price')}</th>
          <th className="num">{t('offers.onHand')}</th>
          <th className="num">{t('offers.reserved')}</th>
          <th className="num">{t('offers.available')}</th>
          <th>{t('common.status')}</th>
        </tr>
      </thead>
      <tbody>
        {offers.map((o) => (
          <tr key={o.id}>
            <td>
              {o.sku}
              <div className="muted small">
                {nameIn(o.productNames, locale)} {o.options.sizeMl ? `· ${String(o.options.sizeMl)} ml` : ''}
              </div>
            </td>
            <td>{o.merchantName}</td>
            <td className="num">{o.prices.map((p) => money(p.amountMinor, p.currency)).join(' / ')}</td>
            <td className="num">{o.onHand}</td>
            <td className="num">{o.reserved}</td>
            <td className="num">{o.available}</td>
            <td>
              <Badge prefix="productStatus" value={o.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OffersPage() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<Offer[]>('GET', `/v1/admin/offers?page=${page}&pageSize=${PAGE}${search ? `&q=${encodeURIComponent(search)}` : ''}`), [page, search]);
  return (
    <>
      <h1>{t('section.offers')}</h1>
      <p className="muted">{t('offers.intro')}</p>
      <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => (e.preventDefault(), setPage(1), setSearch(q.trim()))}>
        <input style={{ maxWidth: 320 }} placeholder={t('offers.sku')} aria-label={t('offers.sku')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary">{t('common.search')}</button>
      </form>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : (
        <Card>
          <OfferTable offers={list.data} />
          <Pager page={page} setPage={setPage} count={list.data.length} pageSize={PAGE} />
        </Card>
      )}
    </>
  );
}

type StockRow = { offerId: string; sku: string; merchantName: string; productNames: Record<string, string>; locationCode: string; locationName: string; city: string | null; onHand: number; reserved: number; offerAvailable: number; lowStockThreshold: number | null; low: boolean; updatedAt: string };

export function InventoryPage() {
  const { t, locale, date } = useI18n();
  const [low, setLow] = useState(false);
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<StockRow[]>('GET', `/v1/admin/inventory?page=${page}&pageSize=${PAGE}${low ? '&low=true' : ''}`), [page, low]);
  return (
    <>
      <h1>{t('section.inventory')}</h1>
      <p className="muted">{t('inventory.intro')}</p>
      <label className="row" style={{ marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={low} onChange={(e) => (setLow(e.target.checked), setPage(1))} /> {t('inventory.lowOnly')}
      </label>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('offers.sku')}</th>
                <th>{t('products.merchant')}</th>
                <th>{t('inventory.location')}</th>
                <th className="num">{t('offers.onHand')}</th>
                <th className="num">{t('offers.reserved')}</th>
                <th className="num">{t('inventory.offerAvailable')}</th>
                <th>{t('products.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.offerId + r.locationCode}>
                  <td>
                    {r.sku}
                    <div className="muted small">{nameIn(r.productNames, locale)}</div>
                  </td>
                  <td>{r.merchantName}</td>
                  <td>
                    {r.locationName} <span className="muted small">({r.locationCode}{r.city ? `, ${r.city}` : ''})</span>
                  </td>
                  <td className="num">{r.onHand}</td>
                  <td className="num">{r.reserved}</td>
                  <td className="num">
                    {r.offerAvailable} {r.low && <span className="badge badge-warn">{t('inventory.low')}</span>}
                  </td>
                  <td className="small">{date(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} count={list.data.length} pageSize={PAGE} />
        </Card>
      )}
    </>
  );
}
