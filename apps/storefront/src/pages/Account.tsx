import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, DEMO, type Order } from '../api';
import { ErrorBox, Loading } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useLoad, useShop } from '../store';

/** Sign in or create an account (one ARUMA account works in every ARUMA store). */
export function AuthForm({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const shop = useShop();
  const [mode, setMode] = useState<'signin' | 'register'>(DEMO ? 'register' : 'signin');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className={`auth${compact ? ' compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        (mode === 'signin' ? shop.signIn(form.email, form.password) : shop.register(form.name, form.email, form.password)).catch(setError).finally(() => setPending(false));
      }}
    >
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>
          {t('auth.signIn')}
        </button>
        <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
          {t('auth.register')}
        </button>
      </div>
      {mode === 'register' && (
        <label className="field">
          <span>{t('auth.name')}</span>
          <input id="auth-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
        </label>
      )}
      <label className="field">
        <span>{t('auth.email')}</span>
        <input id="auth-email" type="email" required dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
      </label>
      <label className="field">
        <span>{t('auth.password')}</span>
        <input id="auth-password" type="password" required minLength={mode === 'register' ? 10 : 1} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
        {mode === 'register' && <small className="muted">{t('auth.passwordHint')}</small>}
      </label>
      <ErrorBox error={error} />
      <button className="btn btn-primary" disabled={pending}>
        {mode === 'signin' ? t('auth.signIn') : t('auth.register')}
      </button>
      {DEMO && <p className="muted tiny">{t('demo.account')}</p>}
    </form>
  );
}

const TONE: Record<string, string> = { new: 'warn', processing: 'warn', preparing: 'warn', shipping: 'accent', delivered: 'good', cancelled: 'muted', returned: 'muted', refunded: 'muted' };
export function StatusChip({ status }: { status: string }) {
  const { tx } = useI18n();
  return <span className={`chip chip-${TONE[status] ?? 'muted'}`}>{tx(`status.${status}`, 'status.unknown')}</span>;
}

export function AccountPage() {
  const { t, locale, money, date } = useI18n();
  const shop = useShop();
  const orders = useLoad(() => (shop.user ? api<Order[]>('GET', '/v1/me/orders') : Promise.resolve([])), [shop.user?.id]);
  if (!shop.user)
    return (
      <div className="narrow">
        <h1>{t('account.title')}</h1>
        <p className="lead">{t('account.intro')}</p>
        <AuthForm />
      </div>
    );
  return (
    <div className="account">
      <div className="row-between">
        <h1>{t('account.hello', { name: shop.user.displayName })}</h1>
        <button className="btn btn-ghost" onClick={shop.signOut}>
          {t('auth.signOut')}
        </button>
      </div>
      <h2>{t('account.orders')}</h2>
      <ErrorBox error={orders.error} />
      {!orders.data ? (
        <Loading />
      ) : orders.data.length === 0 ? (
        <p className="muted">{t('account.noOrders')}</p>
      ) : (
        <ul className="order-list" data-testid="orders">
          {orders.data.map((o) => (
            <li key={o.id}>
              <Link to={`/account/orders/${o.id}`} className="order-row">
                <span>
                  <strong><bdi>{o.number}</bdi></strong>
                  <span className="muted small"> · {date(o.placedAt)}</span>
                </span>
                <span className="muted small">{o.lines.map((l) => l.productNames[locale] ?? Object.values(l.productNames)[0]).join('، ')}</span>
                <StatusChip status={o.status} />
                <strong>{money(o.totalMinor)}</strong>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STEPS = ['new', 'processing', 'preparing', 'shipping', 'delivered'] as const;

export function OrderPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { t, locale, money, date, ml } = useI18n();
  const order = useLoad(() => api<Order>('GET', `/v1/me/orders/${id}`), [id]);
  const [error, setError] = useState<unknown>(null);
  if (order.error) return <ErrorBox error={order.error} />;
  const o = order.data;
  if (!o) return <Loading />;
  const reached = STEPS.indexOf(o.status as (typeof STEPS)[number]);
  const canCancel = o.allowedTransitions.some((x) => x.to === 'cancelled');
  return (
    <div className="order">
      {params.get('new') && (
        <div className="success" data-testid="order-success">
          <strong>{t('order.thanks')}</strong>
          <span>{t('order.thanksText')}</span>
        </div>
      )}
      <div className="row-between">
        <h1>
          {t('order.title')} <bdi>{o.number}</bdi>
        </h1>
        <StatusChip status={o.status} />
      </div>
      <p className="muted">
        {date(o.placedAt)} · {t('product.soldBy', { seller: o.merchant.name })}
      </p>
      {reached >= 0 && (
        <ol className="timeline" data-testid="timeline">
          {STEPS.map((s, i) => (
            <li key={s} className={i <= reached ? 'done' : ''}>
              <span className="dot" />
              <span>{t(`status.${s}` as MessageKey)}</span>
            </li>
          ))}
        </ol>
      )}
      {o.cod && o.status === 'new' && (
        <p className="note">{o.cod.confirmationStatus === 'confirmed' ? t('order.codConfirmed') : t('order.codPending')}</p>
      )}
      <div className="order-grid">
        <section className="panel">
          <h2>{t('order.items')}</h2>
          <ul className="summary-lines">
            {o.lines.map((l) => (
              <li key={l.id}>
                <span>
                  {l.quantity} × {l.productNames[locale] ?? Object.values(l.productNames)[0]} {l.options.sizeMl ? ml(l.options.sizeMl) : ''}
                </span>
                <span>{money(l.lineTotalMinor)}</span>
              </li>
            ))}
          </ul>
          <div className="row-between">
            <span>{t('checkout.shipping')}</span>
            <span>{o.shippingMinor ? money(o.shippingMinor) : t('checkout.free')}</span>
          </div>
          <div className="row-between total">
            <span>{t('checkout.total')}</span>
            <strong>{money(o.totalMinor)}</strong>
          </div>
          <p className="muted small">{o.paymentMethod === 'cash_on_delivery' ? t('order.payCod', { amount: money(o.cod?.amountDueMinor ?? o.totalMinor) }) : t('order.paidOnline')}</p>
        </section>
        <section className="panel">
          <h2>{t('order.delivery')}</h2>
          <p>
            {o.shippingAddress.fullName}
            <br />
            {o.shippingAddress.line1}
            <br />
            {o.shippingAddress.city}، {o.shippingAddress.region}
            <br />
            <span dir="ltr">{o.shippingAddress.phone}</span>
          </p>
          {o.delivery && (
            <p className="muted small">
              {o.delivery.name} · {o.delivery.maxDays === 0 ? t('checkout.today') : t('checkout.days', { min: o.delivery.minDays, max: o.delivery.maxDays })}
            </p>
          )}
          {o.shipment?.trackingNumber && <p className="small">{t('order.tracking', { n: o.shipment.trackingNumber })}</p>}
        </section>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <Link to="/account" className="btn btn-ghost">
          {t('order.back')}
        </Link>
        {canCancel && (
          <button className="btn btn-danger" onClick={() => api('POST', `/v1/me/orders/${o.id}/cancel`, { reason: t('order.cancelReason') }).then(() => order.reload(), setError)}>
            {t('order.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
