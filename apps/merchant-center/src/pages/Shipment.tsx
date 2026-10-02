import { useState } from 'react';
import { api, money } from '../api';
import { Card, ErrorBox, Field, useAction } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

export type ShipmentStatus = 'pending' | 'ready_for_pickup' | 'in_transit' | 'out_for_delivery' | 'delivery_failed' | 'delivered' | 'returning' | 'returned' | 'cancelled';
export type Delivery = {
  methodId: string;
  type: 'merchant_delivery' | 'courier' | 'local_pickup' | 'pickup_point';
  name: string;
  courierCode: string | null;
  courierName: string | null;
  minDays: number;
  maxDays: number;
  pickupLocation?: { address: string; hours?: string } | null;
  pickupPoint?: { name: string; address: string; hours?: string | null } | null;
};
export type Shipment = {
  id: string;
  status: ShipmentStatus;
  methodType: Delivery['type'];
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackedByCourier: boolean;
  codAmountMinor: number;
  labelUrl?: string | null;
  events: { status: ShipmentStatus; source: string; actorName: string | null; description: string | null; location: string | null; occurredAt: string }[];
};

const tone: Record<ShipmentStatus, string> = {
  pending: 'muted',
  ready_for_pickup: 'warn',
  in_transit: 'warn',
  out_for_delivery: 'warn',
  delivery_failed: 'bad',
  delivered: 'good',
  returning: 'bad',
  returned: 'bad',
  cancelled: 'muted',
};

/** Next statuses offered to the merchant, by kind of delivery (the server enforces the full rule table). */
const NEXT: Record<'road' | 'pickup', Partial<Record<ShipmentStatus, ShipmentStatus[]>>> = {
  road: {
    pending: ['in_transit', 'out_for_delivery'],
    in_transit: ['out_for_delivery', 'delivered', 'delivery_failed', 'returning'],
    out_for_delivery: ['delivered', 'delivery_failed', 'returning'],
    delivery_failed: ['out_for_delivery', 'returning', 'returned'],
    returning: ['returned'],
  },
  pickup: { pending: ['ready_for_pickup'], ready_for_pickup: ['delivered', 'returned'] },
};

export function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  const { t } = useI18n();
  return <span className={`badge badge-${tone[status]}`}>{t(`shipmentStatus.${status}` as MessageKey)}</span>;
}

export function DeliveryInfo({ delivery }: { delivery: Delivery | null }) {
  const { t } = useI18n();
  if (!delivery) return <p className="muted small">{t('delivery.none')}</p>;
  return (
    <p className="small" style={{ margin: 0 }}>
      <strong>{delivery.name}</strong> · {t(`shippingType.${delivery.type}` as MessageKey)}
      {delivery.courierName && <> · {delivery.courierName}</>}
      <br />
      <span className="muted">{t('shipping.days', { min: delivery.minDays, max: delivery.maxDays })}</span>
      {delivery.pickupLocation && (
        <>
          <br />
          {t('delivery.pickupAt')}: {delivery.pickupLocation.address} {delivery.pickupLocation.hours && <>({delivery.pickupLocation.hours})</>}
        </>
      )}
      {delivery.pickupPoint && (
        <>
          <br />
          {t('delivery.pickupAt')}: {delivery.pickupPoint.name}, {delivery.pickupPoint.address}
        </>
      )}
    </p>
  );
}

/** The order's parcel: prepare it, enter the tracking number, follow it, and its history. */
export function ShipmentPanel({
  orderUrl,
  orderStatus,
  delivery,
  shipment,
  currency,
  onDone,
}: {
  orderUrl: string;
  orderStatus: string;
  delivery: Delivery | null;
  shipment: Shipment | null;
  currency: string;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const action = useAction();
  const [form, setForm] = useState({ trackingNumber: '', note: '', location: '' });
  const [next, setNext] = useState<ShipmentStatus | null>(null);
  if (!delivery) return null;
  const isCourier = delivery.type === 'courier' || delivery.type === 'pickup_point';
  const live = shipment && shipment.status !== 'cancelled' ? shipment : null;

  const prepare = () =>
    action.run(async () => {
      await api('POST', `${orderUrl}/shipment`, form.trackingNumber.trim() ? { trackingNumber: form.trackingNumber.trim() } : {});
      setForm({ trackingNumber: '', note: '', location: '' });
      onDone();
    });
  const update = (status: ShipmentStatus) =>
    action.run(async () => {
      await api('POST', `${orderUrl}/shipment/status`, {
        status,
        ...(form.trackingNumber.trim() ? { trackingNumber: form.trackingNumber.trim() } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(form.location.trim() ? { location: form.location.trim() } : {}),
      });
      setNext(null);
      setForm({ trackingNumber: '', note: '', location: '' });
      onDone();
    });

  const options = live && !live.trackedByCourier ? (NEXT[delivery.type === 'local_pickup' ? 'pickup' : 'road'][live.status] ?? []) : [];
  const needsTracking = (to: ShipmentStatus) => isCourier && live && !live.trackingNumber && to !== 'cancelled';

  return (
    <div data-testid="shipment">
      <Card title={t('shipment.title')} actions={live ? <ShipmentStatusBadge status={live.status} /> : undefined}>
        <DeliveryInfo delivery={delivery} />
        {!live && ['processing', 'preparing'].includes(orderStatus) && (
          <form
            className="row"
            style={{ marginTop: 12, alignItems: 'flex-end' }}
            onSubmit={(e) => {
              e.preventDefault();
              void prepare();
            }}
          >
            {isCourier && (
              <Field label={t('shipment.trackingNumber')} hint={t('shipment.trackingLater')}>
                <input dir="ltr" maxLength={64} value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} />
              </Field>
            )}
            <button className="primary" disabled={action.pending}>
              {t('shipment.prepare')}
            </button>
          </form>
        )}
        {!live && orderStatus === 'new' && <p className="muted small">{t('shipment.confirmFirst')}</p>}
        {live && (
          <>
            <table style={{ marginTop: 8 }}>
              <tbody>
                {isCourier && (
                  <tr>
                    <td>{t('shipment.trackingNumber')}</td>
                    <td dir="ltr">
                      {live.trackingNumber ? (
                        live.trackingUrl ? (
                          <a href={live.trackingUrl} target="_blank" rel="noreferrer">
                            {live.trackingNumber}
                          </a>
                        ) : (
                          live.trackingNumber
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )}
                {live.codAmountMinor > 0 && (
                  <tr>
                    <td>{t('shipment.cod')}</td>
                    <td className="num">{money.format(live.codAmountMinor, currency, locale)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {live.trackedByCourier && <p className="muted small">{t('shipment.trackedByCourier')}</p>}
            {live.status === 'returned' && orderStatus === 'shipping' && <div className="alert alert-warn">{t('shipment.confirmReturn')}</div>}
            {options.length > 0 && (
              <div className="row" style={{ marginTop: 8 }}>
                {options.map((to) => (
                  <button key={to} className={['delivery_failed', 'returning', 'returned'].includes(to) ? 'danger' : 'primary'} disabled={action.pending} onClick={() => setNext(to)}>
                    {t(`shipmentAction.${to}` as MessageKey)}
                  </button>
                ))}
              </div>
            )}
            {next && (
              <form
                className="stack"
                style={{ marginTop: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void update(next);
                }}
              >
                {needsTracking(next) && (
                  <Field label={t('shipment.trackingNumber')}>
                    <input dir="ltr" required minLength={3} maxLength={64} value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} />
                  </Field>
                )}
                <Field label={t('shipment.location')}>
                  <input maxLength={200} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
                </Field>
                <Field label={t('orders.note')}>
                  <input maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                </Field>
                <div className="row">
                  <button className="primary" disabled={action.pending}>
                    {t('orders.confirm')} · {t(`shipmentAction.${next}` as MessageKey)}
                  </button>
                  <button type="button" onClick={() => setNext(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </form>
            )}
            <h3 className="small" style={{ marginTop: 16 }}>
              {t('shipment.history')}
            </h3>
            <table data-testid="shipment-history">
              <tbody>
                {live.events.map((e, i) => (
                  <tr key={i}>
                    <td className="small">{new Date(e.occurredAt).toLocaleString(locale)}</td>
                    <td>
                      <ShipmentStatusBadge status={e.status} />
                    </td>
                    <td className="small">
                      {t(`shipmentSource.${e.source}` as MessageKey)}
                      {e.actorName && <span className="muted"> · {e.actorName}</span>}
                    </td>
                    <td className="small">
                      {e.location}
                      {e.description && <div className="muted">{e.description}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <ErrorBox error={action.error} />
      </Card>
    </div>
  );
}
