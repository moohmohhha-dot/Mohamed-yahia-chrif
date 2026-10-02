import { useState } from 'react';
import { api, money } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

type Area = { id: string; level: 'region' | 'district' | 'locality'; code?: string | null; names: Record<string, string> };
type Rate = { id: string; zoneId: string | null; currency: string; priceMinor: number; freeAboveMinor: number | null; minDays: number; maxDays: number };
type MethodType = 'merchant_delivery' | 'courier' | 'local_pickup' | 'pickup_point';
type Method = {
  id: string;
  type: MethodType;
  name: string;
  courierCode: string | null;
  pickupLocation: { address: string; hours?: string; phone?: string } | null;
  cashOnDelivery: boolean;
  active: boolean;
  rates: Rate[];
};
type Zone = { id: string; name: string; country: string; areas: Area[] };
type Settings = { country: string; methods: Method[]; zones: Zone[]; couriers: { code: string; name: string; integration: 'manual' | 'api' }[] };

/** Area names come in Arabic and French; English screens use the French (Latin) spelling. */
export const areaName = (names: Record<string, string>, locale: string) => names[locale] ?? names.fr ?? Object.values(names)[0] ?? '';

export function ShippingPage() {
  const { t } = useI18n();
  const merchant = useMerchant();
  const base = `/v1/merchants/${merchant.id}/shipping`;
  const settings = useLoad(() => api<Settings>('GET', base), [base]);
  const editable = can(merchant.role, 'manageTeam');
  const reload = () => void settings.reload();

  return (
    <>
      <h1>{t('section.shipping')}</h1>
      <p className="muted">{t('shipping.intro')}</p>
      {!editable && <div className="alert alert-warn">{t('shipping.readOnly')}</div>}
      <ErrorBox error={settings.error} />
      {!settings.data ? (
        <Loading />
      ) : (
        <>
          <Zones base={base} settings={settings.data} editable={editable} onChange={reload} />
          {settings.data.methods.length === 0 && <div className="alert alert-warn">{t('shipping.noMethods')}</div>}
          {settings.data.methods.map((m) => (
            <MethodCard key={m.id} base={base} method={m} settings={settings.data!} editable={editable} onChange={reload} />
          ))}
          {editable && <NewMethod base={base} settings={settings.data} onChange={reload} />}
        </>
      )}
    </>
  );
}

function Zones({ base, settings, editable, onChange }: { base: string; settings: Settings; editable: boolean; onChange: () => void }) {
  const { t, locale } = useI18n();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const wilayas = useLoad(() => (open ? api<Area[]>('GET', `/v1/geo/${settings.country}/areas`) : Promise.resolve([] as Area[])), [open, settings.country]);
  const action = useAction();
  const save = () =>
    action.run(async () => {
      await api('POST', `${base}/zones`, { name: name.trim(), country: settings.country, areaIds: picked });
      setName('');
      setPicked([]);
      setOpen(false);
      onChange();
    });
  const archive = (zoneId: string) =>
    action.run(async () => {
      await api('DELETE', `${base}/zones/${zoneId}`);
      onChange();
    });

  return (
    <Card title={t('shipping.zones')} actions={editable && !open ? <button onClick={() => setOpen(true)}>{t('shipping.newZone')}</button> : undefined}>
      <p className="muted small">{t('shipping.zonesHint')}</p>
      {settings.zones.length === 0 ? (
        <p className="muted">{t('shipping.noZones')}</p>
      ) : (
        <table>
          <tbody>
            {settings.zones.map((z) => (
              <tr key={z.id}>
                <td>
                  <strong>{z.name}</strong>
                </td>
                <td className="small">{z.areas.map((a) => areaName(a.names, locale)).join('، ')}</td>
                <td className="num">
                  {editable && (
                    <button className="link" onClick={() => void archive(z.id)} disabled={action.pending}>
                      {t('shipping.archive')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <form
          className="stack"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t('shipping.zoneName')}>
            <input required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <fieldset className="wilaya-grid" aria-label={t('shipping.wilayas')}>
            <legend>{t('shipping.wilayas')}</legend>
            {(wilayas.data ?? []).map((w) => (
              <label key={w.id} className="row small">
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={picked.includes(w.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, w.id] : picked.filter((id) => id !== w.id))}
                />
                <span dir="ltr">{w.code}</span> {areaName(w.names, locale)}
              </label>
            ))}
          </fieldset>
          <div className="row">
            <button className="primary" disabled={action.pending || picked.length === 0}>
              {t('shipping.saveZone')}
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={action.error ?? wilayas.error} />
    </Card>
  );
}

function MethodCard({ base, method, settings, editable, onChange }: { base: string; method: Method; settings: Settings; editable: boolean; onChange: () => void }) {
  const { t, locale } = useI18n();
  const action = useAction();
  const courier = settings.couriers.find((c) => c.code === method.courierCode);
  const zoneName = (id: string | null) => (id ? settings.zones.find((z) => z.id === id)?.name ?? '—' : t('shipping.everywhere'));
  const fmt = (v: number, c: string) => money.format(v, c, locale);
  const toggle = () =>
    action.run(async () => {
      const { id: _id, rates: _rates, ...rest } = method;
      await api('PUT', `${base}/methods/${method.id}`, { ...rest, active: !method.active });
      onChange();
    });
  const removeRate = (rateId: string) =>
    action.run(async () => {
      await api('DELETE', `${base}/methods/${method.id}/rates/${rateId}`);
      onChange();
    });

  return (
    <div data-testid={`method-${method.name}`}>
      <Card
        title={
          <span className="row">
            {method.name} <span className="badge badge-muted">{t(`shippingType.${method.type}` as MessageKey)}</span>
            {!method.active && <span className="badge badge-bad">{t('shipping.inactive')}</span>}
          </span>
        }
        actions={editable ? <button onClick={() => void toggle()}>{method.active ? t('shipping.deactivate') : t('shipping.activate')}</button> : undefined}
      >
        <p className="muted small">
          {courier && <>{courier.name} · </>}
          {method.cashOnDelivery ? t('shipping.codAccepted') : t('shipping.codRefused')}
          {method.pickupLocation && (
            <>
              {' '}
              · {method.pickupLocation.address} {method.pickupLocation.hours && <>({method.pickupLocation.hours})</>}
            </>
          )}
        </p>
        {method.rates.length === 0 ? (
          <p className="alert alert-warn">{t('shipping.noRates')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('shipping.zone')}</th>
                <th className="num">{t('shipping.price')}</th>
                <th className="num">{t('shipping.freeAbove')}</th>
                <th>{t('shipping.delay')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {method.rates.map((r) => (
                <tr key={r.id}>
                  <td>{zoneName(r.zoneId)}</td>
                  <td className="num">{r.priceMinor === 0 ? t('shipping.free') : fmt(r.priceMinor, r.currency)}</td>
                  <td className="num">{r.freeAboveMinor === null ? '—' : fmt(r.freeAboveMinor, r.currency)}</td>
                  <td>{t('shipping.days', { min: r.minDays, max: r.maxDays })}</td>
                  <td className="num">
                    {editable && (
                      <button className="link" onClick={() => void removeRate(r.id)} disabled={action.pending}>
                        {t('shipping.remove')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editable && <RateForm base={base} method={method} zones={settings.zones} onChange={onChange} />}
        <ErrorBox error={action.error} />
      </Card>
    </div>
  );
}

function RateForm({ base, method, zones, onChange }: { base: string; method: Method; zones: Zone[]; onChange: () => void }) {
  const { t } = useI18n();
  const empty = { zoneId: '', price: '', freeAbove: '', minDays: '1', maxDays: '3' };
  const [form, setForm] = useState(empty);
  const action = useAction();
  const save = () =>
    action.run(async () => {
      await api('PUT', `${base}/methods/${method.id}/rates`, {
        zoneId: form.zoneId || null,
        currency: 'DZD',
        priceMinor: money.toMinor(form.price || '0'),
        freeAboveMinor: form.freeAbove ? money.toMinor(form.freeAbove) : null,
        minDays: Number(form.minDays),
        maxDays: Number(form.maxDays),
      });
      setForm(empty);
      onChange();
    });
  return (
    <form
      className="row"
      style={{ marginTop: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t('shipping.zone')}>
        <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
          <option value="">{t('shipping.everywhere')}</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('shipping.priceDzd')}>
        <input inputMode="decimal" required pattern="\d+([.,]\d{1,2})?" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
      </Field>
      <Field label={t('shipping.freeAboveDzd')}>
        <input inputMode="decimal" pattern="\d+([.,]\d{1,2})?" value={form.freeAbove} onChange={(e) => setForm({ ...form, freeAbove: e.target.value })} />
      </Field>
      <Field label={t('shipping.minDays')}>
        <input type="number" min={0} max={60} value={form.minDays} onChange={(e) => setForm({ ...form, minDays: e.target.value })} />
      </Field>
      <Field label={t('shipping.maxDays')}>
        <input type="number" min={0} max={90} value={form.maxDays} onChange={(e) => setForm({ ...form, maxDays: e.target.value })} />
      </Field>
      <button className="primary" disabled={action.pending}>
        {t('shipping.saveRate')}
      </button>
      <ErrorBox error={action.error} />
    </form>
  );
}

function NewMethod({ base, settings, onChange }: { base: string; settings: Settings; onChange: () => void }) {
  const { t } = useI18n();
  const empty = { type: 'merchant_delivery' as MethodType, name: '', courierCode: '', address: '', hours: '', cashOnDelivery: true };
  const [form, setForm] = useState(empty);
  const action = useAction();
  const save = () =>
    action.run(async () => {
      await api('POST', `${base}/methods`, {
        type: form.type,
        name: form.name.trim(),
        ...(form.type === 'courier' ? { courierCode: form.courierCode } : {}),
        ...(form.type === 'local_pickup' ? { pickupLocation: { address: form.address.trim(), ...(form.hours.trim() ? { hours: form.hours.trim() } : {}) } } : {}),
        cashOnDelivery: form.cashOnDelivery,
      });
      setForm(empty);
      onChange();
    });
  return (
    <Card title={t('shipping.newMethod')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-grid">
          <Field label={t('shipping.type')}>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as MethodType })}>
              {(['merchant_delivery', 'courier', 'local_pickup'] as const).map((type) => (
                <option key={type} value={type}>
                  {t(`shippingType.${type}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('shipping.methodName')} hint={t('shipping.methodNameHint')}>
            <input required minLength={2} maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {form.type === 'courier' && (
            <Field label={t('shipping.courier')} hint={t('shipping.courierHint')}>
              <select required value={form.courierCode} onChange={(e) => setForm({ ...form, courierCode: e.target.value })}>
                <option value="" />
                {settings.couriers.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.type === 'local_pickup' && (
            <>
              <Field label={t('shipping.pickupAddress')}>
                <input required minLength={5} maxLength={300} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </Field>
              <Field label={t('shipping.pickupHours')}>
                <input maxLength={200} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <label className="row">
          <input type="checkbox" style={{ width: 'auto' }} checked={form.cashOnDelivery} onChange={(e) => setForm({ ...form, cashOnDelivery: e.target.checked })} />
          {t('shipping.allowCod')}
        </label>
        <div>
          <button className="primary" disabled={action.pending}>
            {t('shipping.createMethod')}
          </button>
        </div>
        <ErrorBox error={action.error} />
      </form>
    </Card>
  );
}
