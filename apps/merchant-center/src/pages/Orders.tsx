import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useMerchant } from '../merchant-context';
import { nameIn, sizeLabel } from './common';

const STATUSES = ['new', 'processing', 'preparing', 'shipping', 'delivered', 'cancelled', 'returned', 'refunded'] as const;
type Status = (typeof STATUSES)[number];
const tone: Record<Status, string> = {
  new: 'warn',
  processing: 'warn',
  preparing: 'warn',
  shipping: 'warn',
  delivered: 'good',
  cancelled: 'muted',
  returned: 'bad',
  refunded: 'muted',
};

type OrderSummary = {
  id: string;
  number: string;
  status: Status;
  currency: string;
  totalMinor: number;
  items: number;
  customerName: string;
  city: string;
  region: string;
  placedAt: string;
};
type OrderDetail = OrderSummary & {
  subtotalMinor: number;
  shippingMinor: number;
  commissionBps: number;
  paymentMethod: string;
  customerNote: string | null;
  shippingAddress: { fullName: string; phone: string; line1: string; line2?: string; city: string; region: string; postalCode?: string; country: string };
  lines: { id: string; sku: string; productNames: Record<string, string>; options: Record<string, unknown>; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  history: { id: string; fromStatus: Status | null; toStatus: Status; actorType: string; actorName: string | null; reason: string | null; note: string | null; createdAt: string }[];
  allowedTransitions: { to: Status; reasonRequired: boolean }[];
};

export function OrderStatusBadge({ status }: { status: Status }) {
  const { t } = useI18n();
  return <span className={`badge badge-${tone[status]}`}>{t(`orderStatus.${status}` as MessageKey)}</span>;
}

export function OrdersPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [params, setParams] = useSearchParams();
  const selected = params.get('order');
  const [status, setStatus] = useState<Status | ''>('');
  const list = useLoad(
    () => api<OrderSummary[]>('GET', `/v1/merchants/${merchant.id}/orders${status ? `?status=${status}` : ''}`),
    [merchant.id, status, selected],
  );

  if (selected) return <OrderDetailView orderId={selected} onBack={() => setParams({})} />;

  return (
    <>
      <h1>{t('section.orders')}</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        {(['', ...STATUSES] as const).map((st) => (
          <button key={st || 'all'} className={status === st ? 'primary' : ''} onClick={() => setStatus(st)}>
            {st ? t(`orderStatus.${st}` as MessageKey) : t('orders.all')}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="muted">{t('orders.empty')}</p>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('orders.number')}</th>
                <th>{t('orders.placedAt')}</th>
                <th>{t('orders.customer')}</th>
                <th className="num">{t('orders.items')}</th>
                <th className="num">{t('orders.total')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((o) => (
                <tr key={o.id}>
                  <td dir="ltr">
                    <button className="link" onClick={() => setParams({ order: o.id })}>
                      {o.number}
                    </button>
                  </td>
                  <td className="small">{new Date(o.placedAt).toLocaleString(locale)}</td>
                  <td>
                    {o.customerName} <span className="muted small">· {o.city}, {o.region}</span>
                  </td>
                  <td className="num">{o.items}</td>
                  <td className="num">{money.format(o.totalMinor, o.currency, locale)}</td>
                  <td>
                    <OrderStatusBadge status={o.status} />
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

function OrderDetailView({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const url = `/v1/merchants/${merchant.id}/orders/${orderId}`;
  const order = useLoad(() => api<OrderDetail>('GET', url), [url]);
  if (order.error) return <ErrorBox error={order.error} />;
  if (!order.data) return <Loading />;
  const o = order.data;
  const fmt = (v: number) => money.format(v, o.currency, locale);

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span dir="ltr">{o.number}</span> <OrderStatusBadge status={o.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('orders.back')}
        </button>
      </div>

      <Actions order={o} url={url} onDone={() => void order.reload()} />

      <div className="form-grid">
        <Card title={t('orders.address')}>
          <p style={{ margin: 0 }}>
            <strong>{o.shippingAddress.fullName}</strong>
            <br />
            <span dir="ltr">{o.shippingAddress.phone}</span>
            <br />
            {o.shippingAddress.line1}
            {o.shippingAddress.line2 && <>, {o.shippingAddress.line2}</>}
            <br />
            {o.shippingAddress.city}, {o.shippingAddress.region} {o.shippingAddress.postalCode ?? ''} · {o.shippingAddress.country}
          </p>
          {o.customerNote && (
            <p className="muted small">
              {t('orders.customerNote')}: {o.customerNote}
            </p>
          )}
        </Card>
        <Card title={t(`orders.payment.${o.paymentMethod}` as MessageKey)}>
          <table>
            <tbody>
              <tr>
                <td>{t('orders.subtotal')}</td>
                <td className="num">{fmt(o.subtotalMinor)}</td>
              </tr>
              <tr>
                <td>{t('orders.shipping')}</td>
                <td className="num">{fmt(o.shippingMinor)}</td>
              </tr>
              <tr>
                <td>
                  <strong>{t('orders.total')}</strong>
                </td>
                <td className="num">
                  <strong>{fmt(o.totalMinor)}</strong>
                </td>
              </tr>
              <tr>
                <td className="muted small">{t('orders.commission')}</td>
                <td className="num muted small">{(o.commissionBps / 100).toLocaleString(locale)} %</td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>

      <Card title={t('orders.lines')}>
        <table>
          <thead>
            <tr>
              <th>{t('variants.product')}</th>
              <th>SKU</th>
              <th className="num">{t('inventory.quantity')}</th>
              <th className="num">{t('orders.unitPrice')}</th>
              <th className="num">{t('orders.total')}</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {nameIn(l.productNames, locale)} · {sizeLabel(l.options)}
                </td>
                <td dir="ltr">{l.sku}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{fmt(l.unitPriceMinor)}</td>
                <td className="num">{fmt(l.lineTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title={t('orders.history')}>
        <p className="muted small">{t('orders.historyReadonly')}</p>
        <table data-testid="order-history">
          <thead>
            <tr>
              <th>{t('inventory.date')}</th>
              <th>{t('common.status')}</th>
              <th>{t('orders.by')}</th>
              <th>{t('orders.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {o.history.map((h) => (
              <tr key={h.id}>
                <td className="small">{new Date(h.createdAt).toLocaleString(locale)}</td>
                <td>
                  <span className="row">
                    {h.fromStatus && (
                      <>
                        <OrderStatusBadge status={h.fromStatus} /> {locale === 'ar' ? '←' : '→'}
                      </>
                    )}
                    <OrderStatusBadge status={h.toStatus} />
                  </span>
                </td>
                <td>
                  {t(`actor.${h.actorType}` as MessageKey)}
                  {h.actorName && <span className="muted small"> · {h.actorName}</span>}
                </td>
                <td>
                  {h.reason}
                  {h.note && <div className="muted small">{h.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/** One button per allowed next status; returns, cancellations (and refunds) open a short form. */
function Actions({ order, url, onDone }: { order: OrderDetail; url: string; onDone: () => void }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<{ to: Status; reasonRequired: boolean } | null>(null);
  const [form, setForm] = useState({ reason: '', note: '', restock: true });
  const action = useAction();
  const send = (to: Status) =>
    action.run(async () => {
      await api('POST', `${url}/status`, {
        to,
        ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(to === 'returned' ? { restock: form.restock } : {}),
      });
      setPending(null);
      setForm({ reason: '', note: '', restock: true });
      onDone();
    });

  const needsForm = (to: Status) => ['cancelled', 'returned', 'shipping'].includes(to);
  return (
    <Card title={t('orders.actions')}>
      {order.allowedTransitions.length === 0 ? (
        <p className="muted">{t('orders.noActions')}</p>
      ) : (
        <div className="row">
          {order.allowedTransitions.map((tr) => (
            <button
              key={tr.to}
              className={tr.to === 'cancelled' || tr.to === 'returned' ? 'danger' : 'primary'}
              disabled={action.pending}
              onClick={() => (needsForm(tr.to) ? setPending(tr) : void send(tr.to))}
            >
              {t(`orderAction.${tr.to}` as MessageKey)}
            </button>
          ))}
        </div>
      )}
      {['returned', 'cancelled'].includes(order.status) && <p className="muted small">{t('orders.refundNote')}</p>}
      {pending && (
        <form
          className="stack"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void send(pending.to);
          }}
        >
          {pending.to !== 'shipping' && (
            <Field label={pending.reasonRequired ? t('orders.reasonRequired') : t('orders.reason')}>
              <input required={pending.reasonRequired} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
          )}
          <Field label={t('orders.note')}>
            <input maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          {pending.to === 'returned' && (
            <label className="row">
              <input type="checkbox" checked={form.restock} onChange={(e) => setForm({ ...form, restock: e.target.checked })} style={{ width: 'auto' }} />
              {t('orders.restock')}
            </label>
          )}
          <div className="row">
            <button className="primary" disabled={action.pending}>
              {t('orders.confirm')} · {t(`orderAction.${pending.to}` as MessageKey)}
            </button>
            <button type="button" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={action.error} />
    </Card>
  );
}
