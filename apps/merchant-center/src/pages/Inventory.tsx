import { useState, type FormEvent } from 'react';
import { api, ApiError, download } from '../api';
import { Card, ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';
import { nameIn, sizeLabel } from './common';

type Level = { locationId: string; locationCode: string; onHand: number; reserved: number; available: number };
type Item = {
  offerId: string;
  sku: string;
  options: Record<string, unknown>;
  status: string;
  productNames: Record<string, string>;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number | null;
  lowStock: boolean;
  locations: Level[];
};
type Location = { id: string; code: string; name: string; city: string | null; isDefault: boolean; status: string; onHand: number; reserved: number };
type Movement = {
  id: string;
  locationCode: string | null;
  delta: number;
  quantityAfter: number;
  reservedDelta: number;
  reason: string;
  note: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actor: string | null;
  createdAt: string;
};
const REASONS = ['restock', 'correction', 'damaged', 'returned'] as const;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function InventoryPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [lowOnly, setLowOnly] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const base = `/v1/merchants/${merchant.id}/inventory`;
  const items = useLoad(() => api<Item[]>('GET', `${base}?lowStock=${lowOnly}&q=${encodeURIComponent(q)}`), [base, lowOnly, q]);
  const locations = useLoad(() => api<Location[]>('GET', `${base}/locations`), [base]);
  const manage = can(merchant.role, 'manageTeam');
  const refresh = () => Promise.all([items.reload(), locations.reload()]);

  return (
    <>
      <div className="topbar">
        <h1>{t('section.inventory')}</h1>
        <div className="row">
          <button onClick={() => void download(`${base}/export?format=csv&locale=${locale}`, 'inventory.csv')}>{t('inventory.export')} CSV</button>
          <button onClick={() => void download(`${base}/export?format=xlsx&locale=${locale}`, 'inventory.xlsx')}>{t('inventory.export')} Excel</button>
        </div>
      </div>

      <Locations locations={locations.data} manage={manage} onChange={refresh} />
      {manage && <Import onDone={refresh} />}

      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <label className="row small">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} style={{ width: 'auto' }} />
          {t('inventory.lowOnly')}
        </label>
      </div>
      <ErrorBox error={items.error} />
      {!items.data ? (
        <Loading />
      ) : items.data.length === 0 ? (
        <p className="muted">{t('offers.empty')}</p>
      ) : (
        items.data.map((item) => (
          <Card
            key={item.offerId}
            title={
              <span className="row">
                {nameIn(item.productNames, locale)} · {sizeLabel(item.options)}
                <span className="muted small" dir="ltr">
                  {item.sku}
                </span>
                {item.lowStock && <span className="badge badge-warn">{t('inventory.lowStock')}</span>}
              </span>
            }
            actions={
              <>
                <StatusBadge status={item.status} />
                <button onClick={() => setOpen(open === item.offerId ? null : item.offerId)}>{open === item.offerId ? t('common.close') : t('common.edit')}</button>
              </>
            }
          >
            <div className="row" data-testid={`stock-${item.sku}`} style={{ gap: 20 }}>
              <span>
                {t('inventory.onHand')}: <strong>{item.onHand}</strong>
              </span>
              <span>
                {t('inventory.reserved')}: <strong>{item.reserved}</strong>
              </span>
              <span>
                {t('inventory.available')}: <strong>{item.available}</strong>
              </span>
            </div>
            {open === item.offerId && (
              <ItemPanel item={item} locations={(locations.data ?? []).filter((l) => l.status === 'active')} manage={manage} onChange={refresh} />
            )}
          </Card>
        ))
      )}
    </>
  );
}

function Locations({ locations, manage, onChange }: { locations: Location[] | null; manage: boolean; onChange: () => Promise<unknown> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const [form, setForm] = useState({ code: '', name: '', city: '' });
  const action = useAction();
  const base = `/v1/merchants/${merchant.id}/inventory/locations`;
  if (!locations) return <Loading />;
  return (
    <Card title={t('inventory.locations')}>
      <table>
        <thead>
          <tr>
            <th>{t('inventory.code')}</th>
            <th>{t('common.name')}</th>
            <th className="num">{t('inventory.onHand')}</th>
            <th className="num">{t('inventory.reserved')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => (
            <tr key={l.id}>
              <td dir="ltr">{l.code}</td>
              <td>
                {l.name} {l.city && <span className="muted small">· {l.city}</span>}
              </td>
              <td className="num">{l.onHand}</td>
              <td className="num">{l.reserved}</td>
              <td className="num">
                {l.isDefault ? (
                  <span className="badge badge-good">{t('inventory.default')}</span>
                ) : (
                  manage && (
                    <button disabled={action.pending} onClick={() => void action.run(async () => (await api('PATCH', `${base}/${l.id}`, { isDefault: true }), await onChange()))}>
                      {t('inventory.makeDefault')}
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {manage && (
        <form
          className="form-grid"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api('POST', base, { code: form.code, name: form.name, ...(form.city ? { city: form.city } : {}) });
              setForm({ code: '', name: '', city: '' });
              await onChange();
            });
          }}
        >
          <Field label={t('inventory.code')}>
            <input required pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" maxLength={32} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('common.name')}>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('field.city')}>
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button disabled={action.pending}>{t('inventory.addLocation')}</button>
          </div>
        </form>
      )}
      <ErrorBox error={action.error} />
    </Card>
  );
}

type ImportResult = { valid: boolean; errors: number; rows: { line: number; sku: string; location: string; before?: number; after?: number; error?: string }[] };

/** Two steps: check the file (dry run), then import it. */
function Import({ onDone }: { onDone: () => Promise<unknown> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [done, setDone] = useState(false);
  const action = useAction();
  const send = (dryRun: boolean) =>
    action.run(async () => {
      const form = new FormData();
      form.append('file', file!);
      try {
        const res = await api<ImportResult>('POST', `/v1/merchants/${merchant.id}/inventory/import?dryRun=${dryRun}`, form);
        setResult(res);
        if (!dryRun) {
          setDone(true);
          setFile(null);
          setResult(null);
          await onDone();
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'IMPORT_INVALID') return; // already shown by the dry run
        throw e;
      }
    });

  return (
    <Card title={t('inventory.import')}>
      <p className="muted small">{t('inventory.importHint')}</p>
      <div className="row">
        <input
          type="file"
          aria-label={t('inventory.import')}
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
            setDone(false);
          }}
          style={{ maxWidth: 320 }}
        />
        <button disabled={!file || action.pending} onClick={() => void send(true)}>
          {t('inventory.importCheck')}
        </button>
      </div>
      <ErrorBox error={action.error} />
      {done && <div className="alert alert-good">{t('inventory.importDone')}</div>}
      {result && (
        <div className="stack" style={{ marginTop: 12 }}>
          {!result.valid && <div className="alert alert-bad">{t('inventory.importErrors', { n: result.errors })}</div>}
          <table>
            <thead>
              <tr>
                <th>{t('inventory.line')}</th>
                <th>SKU</th>
                <th>{t('inventory.location')}</th>
                <th className="num">{t('inventory.before')}</th>
                <th className="num">{t('inventory.after')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.line}</td>
                  <td dir="ltr">{r.sku}</td>
                  <td dir="ltr">{r.location || '—'}</td>
                  <td className="num">{r.before ?? '—'}</td>
                  <td className="num">{r.after ?? '—'}</td>
                  <td className={r.error ? 'missing' : 'muted small'}>{r.error ?? '✓'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.valid && (
            <div>
              <button className="primary" disabled={action.pending} onClick={() => void send(false)}>
                {t('inventory.importApply', { n: result.rows.length })}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ItemPanel({ item, locations, manage, onChange }: { item: Item; locations: Location[]; manage: boolean; onChange: () => Promise<unknown> }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const base = `/v1/merchants/${merchant.id}/inventory`;
  const history = useLoad(() => api<Movement[]>('GET', `${base}/offers/${item.offerId}/history`), [item.offerId, item.onHand, item.reserved]);
  const defaultId = locations.find((l) => l.isDefault)?.id ?? '';
  const [adjust, setAdjust] = useState({ locationId: defaultId, delta: '', reason: 'restock', note: '' });
  const [count, setCount] = useState({ locationId: defaultId, quantity: '' });
  const [transfer, setTransfer] = useState({ fromLocationId: defaultId, toLocationId: locations.find((l) => !l.isDefault)?.id ?? '', quantity: '' });
  const [threshold, setThreshold] = useState(item.lowStockThreshold === null ? '' : String(item.lowStockThreshold));
  const action = useAction();
  const submit = (fn: () => Promise<unknown>) => (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await fn();
      await onChange();
    });
  };
  const locationSelect = (value: string, onSelect: (id: string) => void, label: MessageKey = 'inventory.location') => (
    <Field label={t(label)}>
      <select aria-label={t(label)} value={value} onChange={(e) => onSelect(e.target.value)}>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.code} · {l.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <table>
        <thead>
          <tr>
            <th>{t('inventory.location')}</th>
            <th className="num">{t('inventory.onHand')}</th>
            <th className="num">{t('inventory.reserved')}</th>
            <th className="num">{t('inventory.available')}</th>
          </tr>
        </thead>
        <tbody>
          {item.locations.map((l) => (
            <tr key={l.locationId}>
              <td dir="ltr">{l.locationCode}</td>
              <td className="num">{l.onHand}</td>
              <td className="num">{l.reserved}</td>
              <td className="num">{l.available}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>{t('inventory.adjust')}</h3>
      <form
        className="form-grid"
        onSubmit={submit(async () => {
          await api('POST', `${base}/offers/${item.offerId}/adjust`, {
            locationId: adjust.locationId || undefined,
            delta: Number(adjust.delta),
            reason: adjust.reason,
            ...(adjust.note ? { note: adjust.note } : {}),
          });
          setAdjust({ ...adjust, delta: '', note: '' });
        })}
      >
        {locationSelect(adjust.locationId, (id) => setAdjust({ ...adjust, locationId: id }))}
        <Field label={t('inventory.delta')}>
          <input required type="number" step={1} value={adjust.delta} onChange={(e) => setAdjust({ ...adjust, delta: e.target.value })} dir="ltr" />
        </Field>
        <Field label={t('inventory.reason')}>
          <select value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reason.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('inventory.note')}>
          <input value={adjust.note} maxLength={500} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <button className="primary" disabled={action.pending || !adjust.delta || adjust.delta === '0'}>
            {t('common.save')}
          </button>
        </div>
      </form>

      <h3>{t('inventory.count')}</h3>
      <form
        className="form-grid"
        onSubmit={submit(async () => {
          await api('POST', `${base}/offers/${item.offerId}/count`, { locationId: count.locationId || undefined, quantity: Number(count.quantity) });
          setCount({ ...count, quantity: '' });
        })}
      >
        {locationSelect(count.locationId, (id) => setCount({ ...count, locationId: id }))}
        <Field label={t('inventory.countedQty')}>
          <input required type="number" min={0} step={1} value={count.quantity} onChange={(e) => setCount({ ...count, quantity: e.target.value })} dir="ltr" />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <button disabled={action.pending || count.quantity === ''}>{t('common.save')}</button>
        </div>
      </form>

      {manage && locations.length > 1 && (
        <>
          <h3>{t('inventory.transfer')}</h3>
          <form
            className="form-grid"
            onSubmit={submit(async () => {
              await api('POST', `${base}/transfers`, { offerId: item.offerId, ...transfer, quantity: Number(transfer.quantity) });
              setTransfer({ ...transfer, quantity: '' });
            })}
          >
            {locationSelect(transfer.fromLocationId, (id) => setTransfer({ ...transfer, fromLocationId: id }), 'inventory.from')}
            {locationSelect(transfer.toLocationId, (id) => setTransfer({ ...transfer, toLocationId: id }), 'inventory.to')}
            <Field label={t('inventory.quantity')}>
              <input required type="number" min={1} step={1} value={transfer.quantity} onChange={(e) => setTransfer({ ...transfer, quantity: e.target.value })} dir="ltr" />
            </Field>
            <div style={{ alignSelf: 'end' }}>
              <button disabled={action.pending || !transfer.quantity}>{t('inventory.transfer')}</button>
            </div>
          </form>
        </>
      )}

      <form
        className="row"
        onSubmit={submit(() => api('PUT', `${base}/offers/${item.offerId}/low-stock-threshold`, { threshold: threshold === '' ? null : Number(threshold) }))}
      >
        <Field label={t('inventory.threshold')}>
          <input type="number" min={0} step={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ maxWidth: 120 }} dir="ltr" />
        </Field>
        <button style={{ alignSelf: 'end' }} disabled={action.pending}>
          {t('common.save')}
        </button>
      </form>
      <ErrorBox error={action.error} />

      <h3>{t('inventory.history')}</h3>
      <p className="muted small">{t('inventory.readonly')}</p>
      {history.data && (
        <table>
          <thead>
            <tr>
              <th>{t('inventory.date')}</th>
              <th>{t('inventory.location')}</th>
              <th>{t('inventory.reason')}</th>
              <th className="num">{t('inventory.onHand')}</th>
              <th className="num">{t('inventory.reserved')}</th>
              <th>{t('inventory.reference')}</th>
              <th>{t('inventory.by')}</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((m) => (
              <tr key={m.id}>
                <td className="small">{new Date(m.createdAt).toLocaleString(locale)}</td>
                <td dir="ltr">{m.locationCode ?? '—'}</td>
                <td>
                  {t(`reason.${m.reason}` as MessageKey)}
                  {m.note && <div className="muted small">{m.note}</div>}
                </td>
                <td className="num" dir="ltr">
                  {m.delta !== 0 ? `${signed(m.delta)} → ${m.quantityAfter}` : '—'}
                </td>
                <td className="num" dir="ltr">
                  {m.reservedDelta !== 0 ? signed(m.reservedDelta) : '—'}
                </td>
                <td className="small" dir="ltr">
                  {m.referenceType ? `${m.referenceType}:${m.referenceId?.slice(0, 8)}` : ''}
                </td>
                <td>{m.actor ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
