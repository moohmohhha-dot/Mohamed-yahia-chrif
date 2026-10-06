import { useState } from 'react';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

type Courier = { code: string; name: string; country: string; integration: string; trackingUrlTemplate: string | null; active: boolean };
type Point = { id: string; courierCode: string | null; areaId: string; name: string; address: string; phone: string | null; active: boolean };

/** Delivery companies and pickup desks available to merchants. Courier API keys are entered per merchant or for ARUMA, never shown back. */
export function ShippingPage() {
  const { t, label } = useI18n();
  const couriers = useLoad(() => api<Courier[]>('GET', '/v1/admin/couriers'), []);
  const points = useLoad(() => api<Point[]>('GET', '/v1/admin/pickup-points'), []);
  const [form, setForm] = useState({ code: '', name: '', tracking: '' });
  const action = useAction();
  return (
    <>
      <h1>{t('section.shipping')}</h1>
      <p className="muted">{t('shipping.intro')}</p>
      <ErrorBox error={couriers.error ?? action.error} />
      <Card title={t('shipping.couriers')}>
        {!couriers.data ? (
          <Loading />
        ) : (
          <table>
            <tbody>
              {couriers.data.map((c) => (
                <tr key={c.code}>
                  <td>
                    {c.name} <span className="muted small">({c.code})</span>
                  </td>
                  <td>{label('integration', c.integration)}</td>
                  <td>
                    <Badge prefix="active" value={c.active ? 'active' : 'archived'} />
                  </td>
                  <td>
                    <button onClick={() => void action.run(() => api('PATCH', `/v1/admin/couriers/${c.code}`, { active: !c.active }).then(() => couriers.reload()))}>
                      {c.active ? t('shipping.deactivate') : t('shipping.activate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="form-grid"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() =>
              api('POST', '/v1/admin/couriers', { code: form.code.trim(), name: form.name.trim(), country: 'DZ', ...(form.tracking.trim() ? { trackingUrlTemplate: form.tracking.trim() } : {}) }).then(() => (setForm({ code: '', name: '', tracking: '' }), couriers.reload())),
            );
          }}
        >
          <Field label={t('shipping.code')}>
            <input required pattern="[a-z0-9_]{2,32}" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('common.name')}>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('shipping.tracking')} hint={t('shipping.trackingHint')}>
            <input type="url" value={form.tracking} onChange={(e) => setForm({ ...form, tracking: e.target.value })} dir="ltr" />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button className="primary" disabled={action.pending}>
              {t('shipping.addCourier')}
            </button>
          </div>
        </form>
      </Card>
      <Card title={t('shipping.pickupPoints')}>
        {!points.data ? (
          <Loading />
        ) : points.data.length === 0 ? (
          <Empty>{t('shipping.noPoints')}</Empty>
        ) : (
          <table>
            <tbody>
              {points.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <div className="muted small">{p.address}</div>
                  </td>
                  <td className="small">{p.courierCode}</td>
                  <td>
                    <Badge prefix="active" value={p.active ? 'active' : 'archived'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
