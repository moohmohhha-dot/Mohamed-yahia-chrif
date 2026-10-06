import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Field, Kv, Loading, Pager, ReasonAction, Tabs, useLoad } from '../components/ui';
import { useI18n, type Locale } from '../i18n';

const STATUSES = ['new', 'processing', 'preparing', 'shipping', 'delivered', 'cancelled', 'returned', 'refunded'] as const;
const PAGE = 50;
const nameIn = (names: Record<string, string>, locale: Locale) => names[locale] ?? names.fr ?? names.ar ?? Object.values(names)[0] ?? '—';

type OrderRow = { id: string; number: string; status: string; currency: string; totalMinor: number; paymentMethod: string; paymentStatus: string; placedAt: string; customerName: string; city: string; region: string; items: number; cod: { confirmationStatus: string; riskLevel: string } | null };
type OrderDetail = OrderRow & {
  merchant: { name: string; slug: string };
  subtotalMinor: number;
  shippingMinor: number;
  refundedMinor: number;
  creditAppliedMinor: number;
  amountToPayMinor: number;
  commissionBps: number;
  paymentIntentId: string | null;
  shippingAddress: { fullName: string; phone: string; line1: string; city: string; district?: string; region: string; deliveryNotes?: string };
  delivery: { name: string; type: string; courierName?: string } | null;
  shipment: { status: string; trackingNumber: string | null; courierCode: string | null } | null;
  cod: { confirmationStatus: string; amountDueMinor: number; callAttempts: number; deliveryAttempts: number; outcome: string } | null;
  lines: { id: string; sku: string; productNames: Record<string, string>; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  history: { fromStatus: string | null; toStatus: string; actorType: string; actorName: string | null; reason: string | null; note: string | null; createdAt: string }[];
  allowedTransitions: string[];
};

export function OrdersPage() {
  const { t, label, money, date } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [status, setStatus] = useState<(typeof STATUSES)[number] | ''>('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<OrderRow[]>('GET', `/v1/admin/orders?page=${page}&pageSize=${PAGE}${status ? `&status=${status}` : ''}`), [status, page, selected]);
  if (selected) return <OrderDetailView orderId={selected} onBack={() => setParams({})} />;
  return (
    <>
      <h1>{t('section.orders')}</h1>
      <Tabs value={status} options={STATUSES} onChange={(v) => (setStatus(v), setPage(1))} prefix="orderStatus" allLabel="common.all" />
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
                <th>{t('orders.number')}</th>
                <th>{t('orders.customer')}</th>
                <th className="num">{t('orders.total')}</th>
                <th>{t('orders.payment')}</th>
                <th>{t('common.status')}</th>
                <th>{t('orders.placed')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((o) => (
                <tr key={o.id}>
                  <td dir="ltr">
                    <button className="link" onClick={() => setParams({ id: o.id })}>
                      {o.number}
                    </button>
                  </td>
                  <td>
                    {o.customerName}
                    <div className="muted small">
                      {o.city}, {o.region}
                    </div>
                  </td>
                  <td className="num">{money(o.totalMinor, o.currency)}</td>
                  <td className="small">
                    {label('paymentMethod', o.paymentMethod)} <Badge prefix="paymentStatus" value={o.paymentStatus} />
                  </td>
                  <td>
                    <Badge prefix="orderStatus" value={o.status} />
                  </td>
                  <td className="small">{date(o.placedAt)}</td>
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

function OrderDetailView({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { t, label, money, date, locale } = useI18n();
  const { can } = useAuth();
  const url = `/v1/admin/orders/${orderId}`;
  const order = useLoad(() => api<OrderDetail>('GET', url), [url]);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  if (order.error) return <ErrorBox error={order.error} />;
  if (!order.data) return <Loading />;
  const o = order.data;
  const fmt = (v: number) => money(v, o.currency);
  const reload = () => void order.reload();
  const refundable = o.paymentStatus === 'successful' && o.totalMinor - o.creditAppliedMinor - o.refundedMinor > 0;

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span dir="ltr">{o.number}</span> <Badge prefix="orderStatus" value={o.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('orders.back')}
        </button>
      </div>
      <div className="split">
        <Card title={t('orders.summary')}>
          <Kv
            rows={[
              [t('products.merchant'), o.merchant.name],
              [t('orders.subtotal'), fmt(o.subtotalMinor)],
              [t('orders.shipping'), fmt(o.shippingMinor)],
              [t('orders.total'), <strong>{fmt(o.totalMinor)}</strong>],
              [t('orders.creditApplied'), o.creditAppliedMinor ? fmt(o.creditAppliedMinor) : '—'],
              [t('orders.refunded'), o.refundedMinor ? fmt(o.refundedMinor) : '—'],
              [t('orders.commission'), `${o.commissionBps / 100} %`],
              [t('orders.payment'), <>{label('paymentMethod', o.paymentMethod)} <Badge prefix="paymentStatus" value={o.paymentStatus} /></>],
              [t('orders.placed'), date(o.placedAt)],
            ]}
          />
        </Card>
        <Card title={t('orders.delivery')}>
          <Kv
            rows={[
              [t('orders.customer'), `${o.shippingAddress.fullName}`],
              [t('users.phone'), <span dir="ltr">{o.shippingAddress.phone}</span>],
              [t('merchants.address'), [o.shippingAddress.line1, o.shippingAddress.city, o.shippingAddress.district, o.shippingAddress.region].filter(Boolean).join(', ')],
              [t('orders.notes'), o.shippingAddress.deliveryNotes],
              [t('orders.method'), o.delivery ? `${o.delivery.name}${o.delivery.courierName ? ` · ${o.delivery.courierName}` : ''}` : '—'],
              [t('orders.parcel'), o.shipment ? <><Badge prefix="shipmentStatus" value={o.shipment.status} /> {o.shipment.trackingNumber}</> : '—'],
              ...(o.cod ? ([[t('orders.cod'), <><Badge prefix="codConfirmation" value={o.cod.confirmationStatus} /> {t('orders.codDetail', { calls: o.cod.callAttempts, attempts: o.cod.deliveryAttempts })}</>]] as [string, ReactNode][]) : []),
            ]}
          />
        </Card>
      </div>
      <Card title={t('orders.lines')}>
        <table>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {nameIn(l.productNames, locale)} <span className="muted small">{l.sku}</span>
                </td>
                <td className="num">× {l.quantity}</td>
                <td className="num">{fmt(l.lineTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {(can('orders.manage') && o.allowedTransitions.length > 0) || (can('refunds.execute') && refundable) ? (
        <Card title={t('users.actions')}>
          <div className="row">
            {can('orders.manage') && o.allowedTransitions.length > 0 && (
              <ReasonAction
                label={t('orders.changeStatus')}
                extra={
                  <Field label={t('common.status')}>
                    <select required value={to} onChange={(e) => setTo(e.target.value)}>
                      <option value="" />
                      {o.allowedTransitions.map((s) => (
                        <option key={s} value={s}>
                          {label('orderStatus', s)}
                        </option>
                      ))}
                    </select>
                  </Field>
                }
                onConfirm={(reason) => api('POST', `${url}/status`, { to, reason }).then(reload)}
              />
            )}
            {can('refunds.execute') && refundable && (
              <ReasonAction
                label={t('orders.refund')}
                danger
                extra={
                  <div className="form-grid">
                    <Field label={t('orders.amount', { currency: o.currency })}>
                      <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    </Field>
                    {o.paymentMethod === 'cash_on_delivery' && (
                      <Field label={t('orders.transferReference')} hint={t('orders.transferHint')}>
                        <input required value={reference} onChange={(e) => setReference(e.target.value)} />
                      </Field>
                    )}
                  </div>
                }
                onConfirm={(reason) =>
                  api(
                    'POST',
                    `${url}/refunds`,
                    { amountMinor: Math.round(Number(amount.replace(',', '.')) * 100), reason, ...(reference.trim() ? { externalReference: reference.trim() } : {}) },
                    { 'idempotency-key': crypto.randomUUID() },
                  ).then(reload)
                }
              />
            )}
          </div>
          <p className="muted small">{t('orders.actionsHint')}</p>
        </Card>
      ) : null}
      <Card title={t('orders.history')}>
        <table>
          <tbody>
            {o.history.map((h, i) => (
              <tr key={i}>
                <td className="small">{date(h.createdAt)}</td>
                <td>
                  <Badge prefix="orderStatus" value={h.toStatus} />
                </td>
                <td className="small">{h.actorType === 'platform' ? 'ARUMA' : h.actorName ?? label('actor', h.actorType)}</td>
                <td className="small muted">{h.reason ?? h.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

type Payments = {
  summary: { method: string; status: string; currency: string; n: number; totalMinor: number; refundedMinor: number }[];
  payments: { orderId: string; number: string; merchantName: string; status: string; method: string; paymentStatus: string; paymentIntentId: string | null; currency: string; totalMinor: number; amountDueMinor: number; refundedMinor: number; placedAt: string }[];
};
const PAYMENT_STATUSES = ['pending', 'successful', 'failed', 'cancelled', 'refunded'] as const;

/** Payments as recorded on orders. Card details stay with the payment provider: ARUMA never receives them. */
export function PaymentsPage() {
  const { t, label, money, date } = useI18n();
  const [status, setStatus] = useState<(typeof PAYMENT_STATUSES)[number] | ''>('');
  const [page, setPage] = useState(1);
  const data = useLoad(() => api<Payments>('GET', `/v1/admin/payments?page=${page}&pageSize=${PAGE}${status ? `&status=${status}` : ''}`), [status, page]);
  return (
    <>
      <h1>{t('section.payments')}</h1>
      <p className="muted">{t('payments.intro')}</p>
      <ErrorBox error={data.error} />
      {!data.data ? (
        <Loading />
      ) : (
        <>
          <Card title={t('payments.summary')}>
            <table>
              <thead>
                <tr>
                  <th>{t('orders.payment')}</th>
                  <th>{t('common.status')}</th>
                  <th className="num">{t('payments.count')}</th>
                  <th className="num">{t('payments.amount')}</th>
                  <th className="num">{t('orders.refunded')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.summary.map((s) => (
                  <tr key={s.method + s.status + s.currency}>
                    <td>{label('paymentMethod', s.method)}</td>
                    <td>
                      <Badge prefix="paymentStatus" value={s.status} />
                    </td>
                    <td className="num">{s.n}</td>
                    <td className="num">{money(s.totalMinor, s.currency)}</td>
                    <td className="num">{money(s.refundedMinor, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Tabs value={status} options={PAYMENT_STATUSES} onChange={(v) => (setStatus(v), setPage(1))} prefix="paymentStatus" allLabel="common.all" />
          <Card>
            <table>
              <thead>
                <tr>
                  <th>{t('orders.number')}</th>
                  <th>{t('products.merchant')}</th>
                  <th>{t('orders.payment')}</th>
                  <th className="num">{t('payments.due')}</th>
                  <th className="num">{t('orders.refunded')}</th>
                  <th>{t('payments.reference')}</th>
                  <th>{t('orders.placed')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.payments.map((p) => (
                  <tr key={p.orderId}>
                    <td dir="ltr">{p.number}</td>
                    <td>{p.merchantName}</td>
                    <td className="small">
                      {label('paymentMethod', p.method)} <Badge prefix="paymentStatus" value={p.paymentStatus} />
                    </td>
                    <td className="num">{money(p.amountDueMinor, p.currency)}</td>
                    <td className="num">{p.refundedMinor ? money(p.refundedMinor, p.currency) : '—'}</td>
                    <td className="small muted" dir="ltr">
                      {p.paymentIntentId?.slice(0, 8) ?? '—'}
                    </td>
                    <td className="small">{date(p.placedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={page} setPage={setPage} count={data.data.payments.length} pageSize={PAGE} />
          </Card>
        </>
      )}
    </>
  );
}
