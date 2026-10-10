import { useEffect, useState, type FormEvent } from 'react';
import { api, money } from '../api';
import { Card, ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';
import { useMerchant } from '../merchant-context';
import { loadStore, nameIn, sizeLabel, type Offer, type Product, type StoreInfo } from './common';

export function OffersPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const offers = useLoad(() => api<Offer[]>('GET', `/v1/merchants/${merchant.id}/offers`), [merchant.id]);
  const [editing, setEditing] = useState<{ variantId: string; storeSlug: string; label: string; offer?: Offer } | null>(null);
  const [picking, setPicking] = useState(false);

  const done = () => {
    setEditing(null);
    setPicking(false);
    void offers.reload();
  };

  return (
    <>
      <div className="topbar">
        <h1>{t('section.offers')}</h1>
        {!picking && !editing && (
          <button className="primary" onClick={() => setPicking(true)}>
            {t('offers.new')}
          </button>
        )}
      </div>
      <p className="muted small">{t('offers.hint')}</p>
      {picking && !editing && (
        <CatalogPicker
          onPick={(product, variant) =>
            setEditing({ variantId: variant.id, storeSlug: product.storeSlug, label: `${nameIn(product.translations, locale)} · ${sizeLabel(variant.options)}` })
          }
          onCancel={() => setPicking(false)}
        />
      )}
      {editing && <OfferForm {...editing} onDone={done} onCancel={() => setEditing(null)} />}
      <ErrorBox error={offers.error} />
      {!offers.data ? (
        <Loading />
      ) : offers.data.length === 0 ? (
        <p className="muted">{t('offers.empty')}</p>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('variants.product')}</th>
                <th>{t('products.sku')}</th>
                <th>{t('products.store')}</th>
                <th className="num">{t('offers.prices')}</th>
                <th className="num">{t('inventory.available')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.data.map((o) => (
                <tr key={o.id}>
                  <td>
                    {nameIn(o.product.names, locale)} · {sizeLabel(o.options)}
                  </td>
                  <td dir="ltr">{o.sku}</td>
                  <td>{o.storeSlug}</td>
                  <td className="num">
                    {o.prices.map((p) => (
                      <div key={p.currency}>{money.format(p.amountMinor, p.currency, locale)}</div>
                    ))}
                  </td>
                  <td className="num">{o.availableQuantity}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="num">
                    <button
                      onClick={() =>
                        setEditing({ variantId: o.variantId, storeSlug: o.storeSlug, label: `${nameIn(o.product.names, locale)} · ${sizeLabel(o.options)}`, offer: o })
                      }
                    >
                      {t('common.edit')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function CatalogPicker({ onPick, onCancel }: { onPick: (p: Product, v: Product['variants'][number]) => void; onCancel: () => void }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [q, setQ] = useState('');
  const results = useLoad(() => api<Product[]>('GET', `/v1/merchants/${merchant.id}/catalog?q=${encodeURIComponent(q)}`), [merchant.id, q]);
  return (
    <Card title={t('offers.find')} actions={<button onClick={onCancel}>{t('common.cancel')}</button>}>
      <input type="search" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorBox error={results.error} />
      <table>
        <tbody>
          {results.data?.flatMap((p) =>
            p.variants
              .filter((v) => v.isActive)
              .map((v) => (
                <tr key={v.id}>
                  <td>
                    {nameIn(p.translations, locale)} {!p.ownedByMe && <span className="badge badge-muted">{t('offers.marketplace')}</span>}
                  </td>
                  <td>{sizeLabel(v.options)}</td>
                  <td dir="ltr">{v.sku}</td>
                  <td>{p.storeSlug}</td>
                  <td className="num">
                    <button onClick={() => onPick(p, v)}>{v.myOffer ? t('common.edit') : t('common.add')}</button>
                  </td>
                </tr>
              )),
          )}
        </tbody>
      </table>
    </Card>
  );
}

function OfferForm({
  variantId,
  storeSlug,
  label,
  offer,
  onDone,
  onCancel,
}: {
  variantId: string;
  storeSlug: string;
  label: string;
  offer?: Offer;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [prices, setPrices] = useState<Record<string, { amount: string; compareAt: string }>>({});
  const [stock, setStock] = useState('0');
  const [status, setStatus] = useState(offer?.status ?? 'active');
  const action = useAction();

  useEffect(() => {
    void loadStore(storeSlug).then((s) => {
      setStore(s);
      setPrices(
        Object.fromEntries(
          s.currencies.map((c) => {
            const p = offer?.prices.find((x) => x.currency === c.code);
            return [
              c.code,
              {
                amount: p ? money.fromMinor(p.amountMinor, c.minorUnits) : '',
                compareAt: p?.compareAtMinor != null ? money.fromMinor(p.compareAtMinor, c.minorUnits) : '',
              },
            ];
          }),
        ),
      );
    });
  }, [storeSlug, offer]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!store) return;
    const body = {
      variantId,
      // Opening stock only when the offer is created; afterwards stock is managed in Inventory.
      ...(offer ? {} : { stockQuantity: Number(stock) }),
      status,
      prices: store.currencies
        .filter((c) => prices[c.code]?.amount)
        .map((c) => ({
          currency: c.code,
          amountMinor: money.toMinor(prices[c.code]!.amount, c.minorUnits),
          ...(prices[c.code]!.compareAt ? { compareAtMinor: money.toMinor(prices[c.code]!.compareAt, c.minorUnits) } : {}),
        })),
    };
    void action.run(async () => {
      await api('PUT', `/v1/merchants/${merchant.id}/offers`, body);
      onDone();
    });
  };

  return (
    <Card title={label}>
      {!store ? (
        <Loading />
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="form-grid">
            {store.currencies.map((c) => (
              <div className="stack" key={c.code}>
                <Field label={t('offers.price', { currency: c.code })}>
                  <input
                    required={c.code === store.defaultCurrency}
                    type="number"
                    min={0}
                    step={1 / 10 ** c.minorUnits}
                    value={prices[c.code]?.amount ?? ''}
                    onChange={(e) => setPrices({ ...prices, [c.code]: { ...prices[c.code]!, amount: e.target.value } })}
                    dir="ltr"
                  />
                </Field>
                <Field label={t('offers.compareAt', { currency: c.code })}>
                  <input
                    type="number"
                    min={0}
                    step={1 / 10 ** c.minorUnits}
                    value={prices[c.code]?.compareAt ?? ''}
                    onChange={(e) => setPrices({ ...prices, [c.code]: { ...prices[c.code]!, compareAt: e.target.value } })}
                    dir="ltr"
                  />
                </Field>
              </div>
            ))}
          </div>
          <div className="form-grid">
            {offer ? (
              <Field label={t('inventory.available')}>
                <span>
                  <strong>{offer.availableQuantity}</strong> <span className="muted small">{t('offers.stockManaged')}</span>
                </span>
              </Field>
            ) : (
              <Field label={t('offers.stockInitial')}>
                <input required type="number" min={0} step={1} value={stock} onChange={(e) => setStock(e.target.value)} dir="ltr" />
              </Field>
            )}
            <Field label={t('common.status')}>
              <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'archived')}>
                <option value="active">{t('status.active')}</option>
                <option value="archived">{t('offers.archive')}</option>
              </select>
            </Field>
          </div>
          <ErrorBox error={action.error} />
          <div className="row">
            <button className="primary" disabled={action.pending}>
              {t('common.save')}
            </button>
            <button type="button" onClick={onCancel}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
