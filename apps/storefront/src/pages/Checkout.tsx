import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, DEMO, STORE, type Area, type Checkout, type DeliveryOptions } from '../api';
import { ErrorBox, Loading } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useShop } from '../store';
import { AuthForm } from './Account';

function useAreas(parentId: string | null, enabled = true) {
  const [areas, setAreas] = useState<Area[] | null>(null);
  useEffect(() => {
    setAreas(null);
    if (!enabled) return;
    void api<Area[]>('GET', `/v1/geo/DZ/areas${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`).then(setAreas, () => setAreas([]));
  }, [parentId, enabled]);
  return areas;
}

const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** One page: account, address (Wilaya → Daïra → Commune), delivery per seller, cash on delivery, confirmation code. */
export function CheckoutPage() {
  const { t, locale, money, ml } = useI18n();
  const shop = useShop();
  const navigate = useNavigate();
  const [address, setAddress] = useState({ fullName: shop.user?.displayName ?? '', phone: '', line1: '', deliveryNotes: '' });
  const [wilaya, setWilaya] = useState('');
  const [daira, setDaira] = useState('');
  const [commune, setCommune] = useState('');
  const wilayas = useAreas(null);
  const dairas = useAreas(wilaya || null, Boolean(wilaya));
  const communes = useAreas(daira || null, Boolean(daira));
  const [options, setOptions] = useState<DeliveryOptions | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [placed, setPlaced] = useState<Checkout | null>(null);
  const [code, setCode] = useState('');
  const [key] = useState(newKey);
  const lines = useMemo(() => shop.cart.map((l) => ({ offerId: l.offerId, quantity: l.quantity })), [shop.cart]);
  const name = (a: Area) => a.names[locale] ?? a.names.fr ?? a.names.ar ?? a.id;
  // Signing in on this page fills the name (the customer can still change it).
  useEffect(() => {
    if (shop.user) setAddress((current) => (current.fullName ? current : { ...current, fullName: shop.user!.displayName }));
  }, [shop.user]);

  useEffect(() => {
    setOptions(null);
    if (!commune || !lines.length) return;
    void api<DeliveryOptions>('POST', `/v1/stores/${STORE}/delivery-options`, { lines, country: 'DZ', localityId: commune }).then(
      (o) => {
        setOptions(o);
        setChosen(Object.fromEntries(o.sellers.filter((s) => s.options.length).map((s) => [s.merchantId, [...s.options].sort((a, b) => a.priceMinor - b.priceMinor)[0]!.methodId])));
      },
      setError,
    );
  }, [commune, lines]);

  const shippingMinor = options?.sellers.reduce((sum, s) => sum + (s.options.find((o) => o.methodId === chosen[s.merchantId])?.priceMinor ?? 0), 0) ?? 0;
  const blocked = !options || options.unavailableOfferIds.length > 0 || options.sellers.some((s) => !s.options.length);

  if (placed) {
    const total = placed.orders.reduce((n, o) => n + o.totalMinor, 0);
    return (
      <div className="narrow confirm-box" data-testid="cod-confirm">
        <span className="eyebrow">{t('checkout.placed')}</span>
        <h1>{t('checkout.confirmTitle')}</h1>
        <p>{t('checkout.confirmText', { to: placed.cod?.sentTo ?? address.phone })}</p>
        {DEMO && <p className="note">{t('demo.code')}</p>}
        <form
          className="code-form"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            api('POST', `/v1/me/checkouts/${placed.checkoutId}/cod/confirm`, { code })
              .then(() => {
                shop.clear();
                navigate(`/account/orders/${placed.orders[0]!.id}?new=1`);
              }, setError)
              .finally(() => setPending(false));
          }}
        >
          <input id="cod-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label={t('checkout.code')} placeholder="••••••" />
          <button className="btn btn-primary btn-lg" disabled={pending}>
            {t('checkout.confirm')}
          </button>
        </form>
        <ErrorBox error={error} />
        <p className="muted small">
          {t('checkout.orderNumbers', { n: '' })}<bdi>{placed.orders.map((o) => o.number).join(' · ')}</bdi> · {money(total)}
        </p>
        <p className="muted small">{t('checkout.callInstead')}</p>
      </div>
    );
  }

  if (!shop.cart.length)
    return (
      <div className="narrow">
        <h1>{t('checkout.title')}</h1>
        <p className="lead">{t('cart.empty')}</p>
        <Link to="/shop" className="btn btn-primary">
          {t('home.shopAll')}
        </Link>
      </div>
    );

  const place = () => {
    setPending(true);
    setError(null);
    api<Checkout>(
      'POST',
      `/v1/stores/${STORE}/orders`,
      {
        lines,
        paymentMethod: 'cash_on_delivery',
        locale,
        shippingAddress: { ...address, deliveryNotes: address.deliveryNotes || undefined, country: 'DZ', localityId: commune },
        delivery: Object.entries(chosen).map(([merchantId, methodId]) => ({ merchantId, methodId })),
      },
      { 'idempotency-key': key },
    )
      .then(setPlaced, setError)
      .finally(() => setPending(false));
  };

  return (
    <div className="checkout">
      <h1>{t('checkout.title')}</h1>
      <div className="checkout-body">
        <div className="steps">
          <section className="step">
            <h2>
              <span className="step-n">1</span> {t('checkout.account')}
            </h2>
            {shop.user ? (
              <p>
                {t('checkout.signedInAs', { name: shop.user.displayName })} <span className="muted small">{shop.user.email}</span>
              </p>
            ) : (
              <AuthForm compact />
            )}
          </section>

          <section className={`step${shop.user ? '' : ' disabled'}`}>
            <h2>
              <span className="step-n">2</span> {t('checkout.address')}
            </h2>
            <div className="form-grid">
              <label className="field">
                <span>{t('checkout.fullName')}</span>
                <input id="full-name" required value={address.fullName} onChange={(e) => setAddress({ ...address, fullName: e.target.value })} autoComplete="name" />
              </label>
              <label className="field">
                <span>{t('checkout.phone')}</span>
                <input id="phone" required inputMode="tel" dir="ltr" placeholder="0661 23 45 67" value={address.phone} onChange={(e) => setAddress({ ...address, phone: e.target.value })} autoComplete="tel" />
              </label>
              <label className="field">
                <span>{t('checkout.wilaya')}</span>
                <select id="wilaya" value={wilaya} onChange={(e) => (setWilaya(e.target.value), setDaira(''), setCommune(''))}>
                  <option value="">—</option>
                  {wilayas?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id.slice(3)} · {name(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('checkout.daira')}</span>
                <select id="daira" value={daira} disabled={!wilaya} onChange={(e) => (setDaira(e.target.value), setCommune(''))}>
                  <option value="">—</option>
                  {dairas?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {name(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('checkout.commune')}</span>
                <select id="commune" value={commune} disabled={!daira} onChange={(e) => setCommune(e.target.value)}>
                  <option value="">—</option>
                  {communes?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {name(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field wide">
                <span>{t('checkout.street')}</span>
                <input id="street" required value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} autoComplete="street-address" />
              </label>
              <label className="field wide">
                <span>
                  {t('checkout.notes')} <span className="muted small">({t('common.optional')})</span>
                </span>
                <input id="notes" value={address.deliveryNotes} onChange={(e) => setAddress({ ...address, deliveryNotes: e.target.value })} />
              </label>
            </div>
          </section>

          <section className={`step${commune ? '' : ' disabled'}`}>
            <h2>
              <span className="step-n">3</span> {t('checkout.delivery')}
            </h2>
            {!commune ? (
              <p className="muted">{t('checkout.chooseCommune')}</p>
            ) : !options ? (
              <Loading />
            ) : (
              options.sellers.map((s) => (
                <fieldset key={s.merchantId} className="seller-box">
                  <legend>{t('product.soldBy', { seller: s.merchantName })}</legend>
                  {s.options.length === 0 && <p className="alert alert-bad">{t('checkout.noDelivery')}</p>}
                  {s.options.map((o) => (
                    <label key={o.methodId} className={`option${chosen[s.merchantId] === o.methodId ? ' selected' : ''}`}>
                      <input type="radio" name={`d-${s.merchantId}`} checked={chosen[s.merchantId] === o.methodId} onChange={() => setChosen({ ...chosen, [s.merchantId]: o.methodId })} />
                      <span className="option-text">
                        <strong>{o.courierName ?? o.name}</strong>
                        <span className="muted small">
                          {t(`delivery.${o.type}` as MessageKey)} · {o.maxDays === 0 ? t('checkout.today') : t('checkout.days', { min: o.minDays, max: o.maxDays })}
                          {o.pickupLocation && ` · ${o.pickupLocation.address}`}
                        </span>
                      </span>
                      <strong>{o.priceMinor === 0 ? t('checkout.free') : money(o.priceMinor)}</strong>
                    </label>
                  ))}
                </fieldset>
              ))
            )}
          </section>

          <section className="step">
            <h2>
              <span className="step-n">4</span> {t('checkout.payment')}
            </h2>
            <label className="option selected">
              <input type="radio" checked readOnly />
              <span className="option-text">
                <strong>{t('checkout.cod')}</strong>
                <span className="muted small">{t('checkout.codText')}</span>
              </span>
            </label>
            <label className="option disabled">
              <input type="radio" disabled />
              <span className="option-text">
                <strong>{t('checkout.card')}</strong>
                <span className="muted small">{t('checkout.cardSoon')}</span>
              </span>
            </label>
          </section>
        </div>

        <aside className="summary">
          <h2>{t('checkout.summary')}</h2>
          <ul className="summary-lines">
            {shop.cart.map((l) => (
              <li key={l.offerId}>
                <span>
                  {l.quantity} × {l.name} {l.sizeMl ? ml(l.sizeMl) : ''}
                </span>
                <span>{money(l.unitPriceMinor * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <div className="row-between">
            <span>{t('cart.subtotal')}</span>
            <span>{money(shop.subtotalMinor)}</span>
          </div>
          <div className="row-between">
            <span>{t('checkout.shipping')}</span>
            <span>{options ? (shippingMinor ? money(shippingMinor) : t('checkout.free')) : '—'}</span>
          </div>
          <div className="row-between total">
            <span>{t('checkout.total')}</span>
            <strong data-testid="total">{money(shop.subtotalMinor + shippingMinor)}</strong>
          </div>
          <ErrorBox error={error} />
          <button
            className="btn btn-primary btn-lg block"
            disabled={pending || !shop.user || blocked || !address.fullName || !address.phone || !address.line1}
            onClick={place}
            data-testid="place-order"
          >
            {t('checkout.place')}
          </button>
          <p className="muted tiny">{t('checkout.terms')}</p>
        </aside>
      </div>
    </div>
  );
}
