import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download, money } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';
import { nameIn, sizeLabel } from './common';
import { ShipmentStatusBadge, type Shipment } from './Shipment';

const STATUSES = ['requested', 'under_review', 'approved', 'rejected', 'in_transit', 'received', 'inspection_failed', 'refund_pending', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number] | 'draft';
const tone: Record<Status, string> = {
  draft: 'muted',
  requested: 'warn',
  under_review: 'warn',
  approved: 'warn',
  rejected: 'bad',
  cancelled: 'muted',
  in_transit: 'warn',
  received: 'warn',
  inspection_failed: 'bad',
  refund_pending: 'warn',
  completed: 'good',
};

type Summary = { id: string; number: string; status: Status; orderNumber: string; customerName: string; reason: string; requestedResolution: string; itemsValueMinor: number; currency: string; responseDueAt: string | null; createdAt: string };
type Detail = Summary & {
  orderId: string;
  paymentMethod: string;
  description: string;
  resolution: string | null;
  returnMethod: string | null;
  approvedAmountMinor: number | null;
  finalAmountMinor: number | null;
  partialReason: string | null;
  merchantNote: string | null;
  escalationReason: string | null;
  adminNote: string | null;
  finalDecision: boolean;
  inspectionNote: string | null;
  refundReference: string | null;
  replacementOrder: { id: string; number: string; status: string } | null;
  customer: { name: string; phone: string; city: string; region: string };
  lines: { id: string; sku: string; productNames: Record<string, string>; options: Record<string, unknown>; quantity: number; unitPriceMinor: number; restock: boolean | null }[];
  evidence: { id: string; role: string; fileName: string | null; contentType: string; createdAt: string }[];
  pickup: Shipment | null;
  events: { type: string; fromStatus: Status | null; toStatus: Status | null; actorType: string; actorName: string | null; note: string | null; createdAt: string }[];
};

export function ReturnStatusBadge({ status }: { status: Status }) {
  const { t } = useI18n();
  return <span className={`badge badge-${tone[status]}`}>{t(`returnStatus.${status}` as MessageKey)}</span>;
}

export function ReturnsPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [params, setParams] = useSearchParams();
  const selected = params.get('return');
  const [status, setStatus] = useState<Status | ''>('');
  const list = useLoad(() => api<Summary[]>('GET', `/v1/merchants/${merchant.id}/returns${status ? `?status=${status}` : ''}`), [merchant.id, status, selected]);
  if (selected) return <ReturnDetail returnId={selected} onBack={() => setParams({})} />;

  return (
    <>
      <h1>{t('section.returns')}</h1>
      <p className="muted">{t('returns.intro')}</p>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {(['', ...STATUSES] as const).map((st) => (
          <button key={st || 'all'} className={status === st ? 'primary' : ''} onClick={() => setStatus(st)}>
            {st ? t(`returnStatus.${st}` as MessageKey) : t('orders.all')}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="muted">{t('returns.empty')}</p>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('returns.number')}</th>
                <th>{t('orders.number')}</th>
                <th>{t('orders.customer')}</th>
                <th>{t('returns.reason')}</th>
                <th>{t('returns.wants')}</th>
                <th className="num">{t('returns.value')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td dir="ltr">
                    <button className="link" onClick={() => setParams({ return: r.id })}>
                      {r.number}
                    </button>
                  </td>
                  <td dir="ltr">{r.orderNumber}</td>
                  <td>{r.customerName}</td>
                  <td>{t(`returnReason.${r.reason}` as MessageKey)}</td>
                  <td>{t(`resolution.${r.requestedResolution}` as MessageKey)}</td>
                  <td className="num">{money.format(r.itemsValueMinor, r.currency, locale)}</td>
                  <td>
                    <ReturnStatusBadge status={r.status} />
                    {r.status === 'requested' && r.responseDueAt && (
                      <div className="muted small">{t('returns.answerBy', { date: new Date(r.responseDueAt).toLocaleString(locale) })}</div>
                    )}
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

function ReturnDetail({ returnId, onBack }: { returnId: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const url = `/v1/merchants/${merchant.id}/returns/${returnId}`;
  const ret = useLoad(() => api<Detail>('GET', url), [url]);
  const action = useAction();
  if (ret.error) return <ErrorBox error={ret.error} />;
  if (!ret.data) return <Loading />;
  const r = ret.data;
  const fmt = (v: number) => money.format(v, r.currency, locale);
  const decide = can(merchant.role, 'manageTeam');
  const reload = () => void ret.reload();
  const run = (fn: () => Promise<unknown>) => action.run(async () => (await fn(), reload()));

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span dir="ltr">{r.number}</span> <ReturnStatusBadge status={r.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('returns.back')}
        </button>
      </div>

      <div className="form-grid">
        <Card title={t('returns.request')}>
          <table>
            <tbody>
              <tr>
                <td>{t('orders.number')}</td>
                <td dir="ltr">{r.orderNumber}</td>
              </tr>
              <tr>
                <td>{t('orders.customer')}</td>
                <td>
                  {r.customer.name} <span className="muted small" dir="ltr">{r.customer.phone}</span>
                  <div className="muted small">
                    {r.customer.city}, {r.customer.region}
                  </div>
                </td>
              </tr>
              <tr>
                <td>{t('returns.reason')}</td>
                <td>
                  <strong>{t(`returnReason.${r.reason}` as MessageKey)}</strong>
                </td>
              </tr>
              <tr>
                <td>{t('returns.wants')}</td>
                <td>{t(`resolution.${r.requestedResolution}` as MessageKey)}</td>
              </tr>
            </tbody>
          </table>
          <p style={{ whiteSpace: 'pre-wrap' }} data-testid="return-description">
            {r.description}
          </p>
        </Card>
        <Card title={t('returns.amounts')}>
          <table>
            <tbody>
              <tr>
                <td>{t('returns.value')}</td>
                <td className="num">{fmt(r.itemsValueMinor)}</td>
              </tr>
              {r.approvedAmountMinor !== null && (
                <tr>
                  <td>{t('returns.approvedAmount')}</td>
                  <td className="num">{fmt(r.approvedAmountMinor)}</td>
                </tr>
              )}
              {r.finalAmountMinor !== null && (
                <tr>
                  <td>
                    <strong>{r.status === 'completed' ? t(`returns.final.${r.resolution ?? 'refund'}` as MessageKey) : t('returns.final.pending')}</strong>
                  </td>
                  <td className="num">
                    <strong>{fmt(r.finalAmountMinor)}</strong>
                  </td>
                </tr>
              )}
              {r.resolution && (
                <tr>
                  <td>{t('returns.resolution')}</td>
                  <td className="num">
                    {t(`resolution.${r.resolution}` as MessageKey)}
                    {r.returnMethod && <div className="muted small">{t(`returnMethod.${r.returnMethod}` as MessageKey)}</div>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {r.partialReason && <p className="small">{t('returns.partialBecause', { reason: r.partialReason })}</p>}
          {r.status === 'refund_pending' && <div className="alert alert-warn">{t('returns.refundByAruma')}</div>}
          {r.replacementOrder && (
            <p className="small">
              {t('returns.replacementOrder')}: <span dir="ltr">{r.replacementOrder.number}</span>
            </p>
          )}
          {r.adminNote && (
            <p className="small">
              <strong>ARUMA</strong>: {r.adminNote}
            </p>
          )}
        </Card>
      </div>

      <Card title={t('returns.items')}>
        <table>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {nameIn(l.productNames, locale)} · {sizeLabel(l.options)}
                </td>
                <td dir="ltr">{l.sku}</td>
                <td className="num">× {l.quantity}</td>
                <td className="num">{fmt(l.unitPriceMinor * l.quantity)}</td>
                <td>{l.restock === null ? '' : l.restock ? t('returns.restocked') : t('returns.notRestocked')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title={t('returns.evidence')}
        actions={
          !['completed', 'cancelled', 'draft'].includes(r.status) ? (
            <input
              type="file"
              aria-label={t('returns.addEvidence')}
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append('file', file);
                void run(() => api('POST', `${url}/evidence`, form));
              }}
            />
          ) : undefined
        }
      >
        {r.evidence.length === 0 ? (
          <p className="muted">{t('returns.noEvidence')}</p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {r.evidence.map((e, i) => (
              <button key={e.id} onClick={() => void download(`${url}/evidence/${e.id}`, e.fileName ?? `evidence-${i + 1}`)}>
                {t(`evidenceRole.${e.role}` as MessageKey)} · {i + 1}
              </button>
            ))}
          </div>
        )}
      </Card>

      <NextStep r={r} url={url} decide={decide} run={run} pending={action.pending} />
      <ErrorBox error={action.error} />

      <Card title={t('returns.history')}>
        <p className="muted small">{t('orders.historyReadonly')}</p>
        <table data-testid="return-history">
          <tbody>
            {r.events.map((e, i) => (
              <tr key={i}>
                <td className="small">{new Date(e.createdAt).toLocaleString(locale)}</td>
                <td className="small">
                  {t(`returnEvent.${e.type}` as MessageKey)}
                  {e.toStatus && (
                    <>
                      {' '}
                      <ReturnStatusBadge status={e.toStatus} />
                    </>
                  )}
                </td>
                <td className="small">
                  {t(`actor.${e.actorType}` as MessageKey)}
                  {e.actorName && <span className="muted"> · {e.actorName}</span>}
                </td>
                <td className="small">{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/** The merchant's next step, depending on where the return is. */
function NextStep({ r, url, decide, run, pending }: { r: Detail; url: string; decide: boolean; run: (fn: () => Promise<unknown>) => Promise<unknown>; pending: boolean }) {
  const { t, locale } = useI18n();
  const [form, setForm] = useState({ resolution: r.requestedResolution, returnMethod: 'pickup', note: '', courierCode: '', trackingNumber: '', amount: '', partialReason: '', result: 'passed' });
  const [restock, setRestock] = useState<Record<string, boolean>>(() => Object.fromEntries(r.lines.map((l) => [l.id, true])));
  const couriers = useLoad(() => api<{ code: string; name: string }[]>('GET', '/v1/couriers'), []);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const note = form.note.trim() ? { note: form.note.trim() } : {};

  if (r.status === 'requested') {
    if (!decide) return <p className="muted">{t('returns.managersDecide')}</p>;
    return (
      <Card title={t('returns.answer')}>
        <div className="form-grid">
          <Field label={t('returns.resolution')}>
            <select value={form.resolution} onChange={set('resolution')}>
              {[...new Set([r.requestedResolution, 'refund'])].map((x) => (
                <option key={x} value={x}>
                  {t(`resolution.${x}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('returns.howBack')}>
            <select value={form.returnMethod} onChange={set('returnMethod')}>
              {['pickup', 'drop_off', 'keep_item'].map((x) => (
                <option key={x} value={x}>
                  {t(`returnMethod.${x}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('returns.noteToCustomer')} hint={t('returns.rejectNeedsReason')}>
          <input maxLength={1000} value={form.note} onChange={set('note')} />
        </Field>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={pending} onClick={() => void run(() => api('POST', `${url}/respond`, { decision: 'approve', resolution: form.resolution, returnMethod: form.returnMethod, ...note }))}>
            {t('returns.approve')}
          </button>
          <button className="danger" disabled={pending} onClick={() => void run(() => api('POST', `${url}/respond`, { decision: 'reject', ...note }))}>
            {t('returns.reject')}
          </button>
        </div>
      </Card>
    );
  }
  if (r.status === 'approved' && r.returnMethod === 'pickup' && !r.pickup) {
    return (
      <Card title={t('returns.arrangePickup')}>
        <div className="form-grid">
          <Field label={t('shipping.courier')} hint={t('returns.ownDriver')}>
            <select value={form.courierCode} onChange={set('courierCode')}>
              <option value="">{t('shippingType.merchant_delivery')}</option>
              {(couriers.data ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('shipment.trackingNumber')}>
            <input dir="ltr" maxLength={64} value={form.trackingNumber} onChange={set('trackingNumber')} />
          </Field>
        </div>
        <button
          className="primary"
          disabled={pending}
          onClick={() =>
            void run(() =>
              api('POST', `${url}/pickup`, { ...(form.courierCode ? { courierCode: form.courierCode } : {}), ...(form.trackingNumber.trim() ? { trackingNumber: form.trackingNumber.trim() } : {}) }),
            )
          }
        >
          {t('returns.createPickup')}
        </button>
      </Card>
    );
  }
  if ((r.status === 'approved' || r.status === 'in_transit') && r.returnMethod !== 'keep_item') {
    return (
      <Card title={t('returns.itemComingBack')}>
        {r.pickup && (
          <p className="row small">
            {t('returns.pickup')}: <ShipmentStatusBadge status={r.pickup.status} /> {r.pickup.courierName} <span dir="ltr">{r.pickup.trackingNumber}</span>
          </p>
        )}
        <div className="row">
          {r.pickup && r.pickup.status === 'pending' && (
            <button disabled={pending} onClick={() => void run(() => api('POST', `${url}/pickup/status`, { status: 'in_transit' }))}>
              {t('returns.collected')}
            </button>
          )}
          <button className="primary" disabled={pending} onClick={() => void run(() => api('POST', `${url}/receive`, {}))}>
            {t('returns.markReceived')}
          </button>
        </div>
      </Card>
    );
  }
  if (r.status === 'received') {
    if (!decide) return <p className="muted">{t('returns.managersDecide')}</p>;
    const lower = form.amount && r.approvedAmountMinor !== null && money.toMinor(form.amount) < r.approvedAmountMinor;
    return (
      <Card title={t('returns.inspection')}>
        <p className="muted small">{t('returns.inspectionHint')}</p>
        {r.lines.map((l) => (
          <label key={l.id} className="row">
            <input type="checkbox" style={{ width: 'auto' }} checked={restock[l.id]} onChange={(e) => setRestock({ ...restock, [l.id]: e.target.checked })} />
            {t('returns.backOnSale')}: {nameIn(l.productNames, locale)} × {l.quantity}
          </label>
        ))}
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label={t('returns.result')}>
            <select value={form.result} onChange={set('result')}>
              <option value="passed">{t('returns.passed')}</option>
              <option value="failed">{t('returns.failed')}</option>
            </select>
          </Field>
          {form.result === 'passed' && r.resolution !== 'replacement' && (
            <Field label={t('returns.amountDzd')} hint={t('returns.amountHint', { amount: money.format(r.approvedAmountMinor ?? 0, r.currency, locale) })}>
              <input inputMode="decimal" pattern="\d+([.,]\d{1,2})?" value={form.amount} onChange={set('amount')} />
            </Field>
          )}
          {lower && (
            <Field label={t('returns.partialReason')}>
              <input required minLength={5} maxLength={500} value={form.partialReason} onChange={set('partialReason')} />
            </Field>
          )}
        </div>
        <Field label={form.result === 'failed' ? t('returns.whatIsWrong') : t('orders.note')}>
          <input maxLength={1000} value={form.note} onChange={set('note')} />
        </Field>
        <button
          className={form.result === 'passed' ? 'primary' : 'danger'}
          disabled={pending}
          style={{ marginTop: 8 }}
          onClick={() =>
            void run(() =>
              api('POST', `${url}/inspection`, {
                result: form.result,
                lines: r.lines.map((l) => ({ returnLineId: l.id, restock: restock[l.id] })),
                ...(form.amount ? { amountMinor: money.toMinor(form.amount) } : {}),
                ...(lower ? { partialReason: form.partialReason.trim() } : {}),
                ...note,
              }),
            )
          }
        >
          {t('returns.saveInspection')}
        </button>
      </Card>
    );
  }
  if (r.status === 'under_review') return <div className="alert alert-warn">{t('returns.underReview')}</div>;
  if (r.status === 'rejected' || r.status === 'inspection_failed') return <p className="muted">{r.finalDecision ? t('returns.finalDecision') : t('returns.customerMayEscalate')}</p>;
  return null;
}
