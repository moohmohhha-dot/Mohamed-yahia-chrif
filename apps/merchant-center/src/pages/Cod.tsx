import { useState } from 'react';
import { api, ApiError, money } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

export type Cod = {
  confirmationStatus: 'pending' | 'confirmed' | 'declined' | 'unreachable' | 'not_required';
  confirmedVia: string | null;
  amountDueMinor: number;
  currency: string;
  deliveryAttempts: number;
  nextAttemptAt: string | null;
  outcome: 'open' | 'delivered' | 'refused' | 'failed' | 'cancelled';
  callAttempts: number;
  maxCallAttempts: number;
  maxDeliveryAttempts: number;
  lastFailureReason: string | null;
  refusalReason: string | null;
  collectionStatus: 'awaiting' | 'with_courier' | 'with_merchant' | 'not_collected';
  collectedAmountMinor: number | null;
  risk: { level: 'low' | 'medium' | 'high'; score: number; reasons: { code: string; count?: number }[] };
  events: { type: string; reason: string | null; note: string | null; actorType: string; actorName: string | null; data: Record<string, unknown>; createdAt: string }[];
};

export const FAILURE_REASONS = ['customer_absent', 'customer_unreachable', 'wrong_address', 'customer_postponed', 'no_cash', 'other'] as const;
export const REFUSAL_REASONS = ['changed_mind', 'price', 'did_not_order', 'not_as_expected', 'too_late', 'other'] as const;
const CALL_OUTCOMES = ['confirmed', 'no_answer', 'call_back_later', 'wrong_number', 'declined'] as const;

const confirmationTone = { pending: 'warn', confirmed: 'good', declined: 'bad', unreachable: 'bad', not_required: 'muted' } as const;
const riskTone = { low: 'good', medium: 'warn', high: 'bad' } as const;
const collectionTone = { awaiting: 'muted', with_courier: 'warn', with_merchant: 'good', not_collected: 'bad' } as const;

export function RiskBadge({ level }: { level: Cod['risk']['level'] }) {
  const { t } = useI18n();
  return <span className={`badge badge-${riskTone[level]}`}>{t(`risk.${level}` as MessageKey)}</span>;
}
export function ConfirmationBadge({ status }: { status: Cod['confirmationStatus'] }) {
  const { t } = useI18n();
  return <span className={`badge badge-${confirmationTone[status]}`}>{t(`codConfirmation.${status}` as MessageKey)}</span>;
}

/** Cash on delivery for one order: confirmation calls, risk, amount due, attempts and where the cash is. */
export function CodPanel({ cod, orderUrl, orderStatus, shipmentStatus, onDone }: { cod: Cod; orderUrl: string; orderStatus: string; shipmentStatus: string | null; onDone: () => void }) {
  const { t, locale } = useI18n();
  const action = useAction();
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const fmt = (v: number) => money.format(v, cod.currency, locale);
  const run = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      setNote('');
      setWhen('');
      onDone();
    });
  const canCall = cod.confirmationStatus === 'pending' && orderStatus === 'new';
  const canReschedule = shipmentStatus === 'delivery_failed' && cod.deliveryAttempts < cod.maxDeliveryAttempts;

  return (
    <div data-testid="cod">
      <Card title={t('cod.title')} actions={<ConfirmationBadge status={cod.confirmationStatus} />}>
        <table>
          <tbody>
            <tr>
              <td>{t('cod.amountDue')}</td>
              <td className="num">
                <strong>{fmt(cod.amountDueMinor)}</strong>
              </td>
            </tr>
            <tr>
              <td>{t('cod.collection')}</td>
              <td className="num">
                <span className={`badge badge-${collectionTone[cod.collectionStatus]}`}>{t(`codCollection.${cod.collectionStatus}` as MessageKey)}</span>
              </td>
            </tr>
            <tr>
              <td>{t('cod.calls')}</td>
              <td className="num">
                {cod.callAttempts} / {cod.maxCallAttempts}
              </td>
            </tr>
            <tr>
              <td>{t('cod.failedAttempts')}</td>
              <td className="num">
                {cod.deliveryAttempts} / {cod.maxDeliveryAttempts}
                {cod.lastFailureReason && <div className="muted small">{t(`failure.${cod.lastFailureReason}` as MessageKey)}</div>}
              </td>
            </tr>
            {cod.nextAttemptAt && (
              <tr>
                <td>{t('cod.nextAttempt')}</td>
                <td className="num">{new Date(cod.nextAttemptAt).toLocaleDateString(locale)}</td>
              </tr>
            )}
            {cod.refusalReason && (
              <tr>
                <td>{t('cod.refused')}</td>
                <td className="num">{t(`refusal.${cod.refusalReason}` as MessageKey)}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="stack" style={{ marginTop: 12 }} data-testid="risk">
          <div className="row">
            <strong>{t('cod.risk')}</strong> <RiskBadge level={cod.risk.level} />
          </div>
          <ul className="small" style={{ margin: 0 }}>
            {cod.risk.reasons.map((r) => (
              <li key={r.code}>{t(`riskReason.${r.code}` as MessageKey, { count: r.count ?? '' })}</li>
            ))}
          </ul>
          <p className="muted small" style={{ margin: 0 }}>
            {t('cod.riskHint')}
          </p>
        </div>

        {canCall && (
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="small" style={{ margin: 0 }}>
              {t('cod.callHint')}
            </p>
            <Field label={t('orders.note')}>
              <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="row">
              {CALL_OUTCOMES.map((outcome) => (
                <button
                  key={outcome}
                  className={outcome === 'confirmed' ? 'primary' : outcome === 'declined' || outcome === 'wrong_number' ? 'danger' : ''}
                  disabled={action.pending}
                  onClick={() => void run(() => api('POST', `${orderUrl}/cod/calls`, { outcome, ...(note.trim() ? { note: note.trim() } : {}) }))}
                >
                  {t(`call.${outcome}` as MessageKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        {canReschedule && (
          <form
            className="row"
            style={{ marginTop: 12, alignItems: 'flex-end' }}
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api('POST', `${orderUrl}/cod/reattempt`, { at: new Date(`${when}T09:00:00`).toISOString(), ...(note.trim() ? { note: note.trim() } : {}) }));
            }}
          >
            <Field label={t('cod.reattemptOn')}>
              <input type="date" required value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
            <Field label={t('orders.note')}>
              <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <button className="primary" disabled={action.pending}>
              {t('cod.scheduleReattempt')}
            </button>
          </form>
        )}
        {shipmentStatus === 'delivery_failed' && !canReschedule && <div className="alert alert-warn">{t('cod.maxAttempts')}</div>}

        <h3 className="small" style={{ marginTop: 16 }}>
          {t('cod.history')}
        </h3>
        <table data-testid="cod-history">
          <tbody>
            {cod.events.map((e, i) => (
              <tr key={i}>
                <td className="small">{new Date(e.createdAt).toLocaleString(locale)}</td>
                <td className="small">
                  {t(`codEvent.${e.type}` as MessageKey)}
                  {e.reason && <span className="muted"> · {reasonLabel(t, e.type, e.reason)}</span>}
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
        <ErrorBox error={action.error} />
      </Card>
    </div>
  );
}

function reasonLabel(t: (k: MessageKey) => string, type: string, reason: string) {
  const key = type === 'call' ? `call.${reason}` : type === 'delivery_failed' ? `failure.${reason}` : type === 'refused' ? `refusal.${reason}` : `codReason.${reason}`;
  const label = t(key as MessageKey);
  return label === key ? reason : label;
}

type Summary = {
  awaiting: { count: number; amountMinor: number };
  withCourier: { count: number; amountMinor: number };
  withMerchant: { count: number; amountMinor: number };
  notCollected: { count: number; amountMinor: number };
  refusalRate: number | null;
  pendingRemittance: { orderId: string; number: string; courierCode: string | null; trackingNumber: string | null; amountMinor: number; currency: string; collectedAt: string }[];
};
type Remittance = { id: string; courierCode: string | null; reference: string; currency: string; collectedMinor: number; courierFeesMinor: number; receivedMinor: number; orderCount: number; createdAt: string };

/** Where the merchant's cash is, and the couriers' payments (each checked against what they collected). */
export function CodPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const base = `/v1/merchants/${merchant.id}/cod`;
  const summary = useLoad(() => api<Summary>('GET', `${base}/summary`), [base]);
  const remittances = useLoad(() => api<Remittance[]>('GET', `${base}/remittances`), [base]);
  const fmt = (v: number) => money.format(v, 'DZD', locale);
  const forbidden = !can(merchant.role, 'manageTeam') || (summary.error instanceof ApiError && summary.error.status === 403);
  const reload = () => {
    void summary.reload();
    void remittances.reload();
  };

  return (
    <>
      <h1>{t('section.cod')}</h1>
      <p className="muted">{t('cod.intro')}</p>
      {forbidden ? (
        <p className="muted">{t('finance.ownersOnly')}</p>
      ) : !summary.data ? (
        <>
          <ErrorBox error={summary.error} />
          <Loading />
        </>
      ) : (
        <>
          <div className="form-grid">
            {(['awaiting', 'withCourier', 'withMerchant', 'notCollected'] as const).map((k) => (
              <Card key={k} title={t(`codSummary.${k}` as MessageKey)}>
                <p style={{ margin: 0, fontSize: '1.4em' }} data-testid={`cod-${k}`}>
                  {fmt(summary.data![k].amountMinor)}
                </p>
                <p className="muted small" style={{ margin: 0 }}>
                  {t('cod.orders', { count: summary.data![k].count })}
                </p>
              </Card>
            ))}
          </div>
          {summary.data.refusalRate !== null && (
            <p className="small">
              {t('cod.refusalRate')}: <strong>{Math.round(summary.data.refusalRate * 100)} %</strong>
            </p>
          )}
          <RemittanceForm base={base} pending={summary.data.pendingRemittance} onDone={reload} />
        </>
      )}
      {!forbidden && remittances.data && (
        <Card title={t('cod.remittances')}>
          {remittances.data.length === 0 ? (
            <p className="muted">{t('cod.noRemittances')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('finance.date')}</th>
                  <th>{t('shipping.courier')}</th>
                  <th>{t('finance.reference')}</th>
                  <th className="num">{t('cod.collected')}</th>
                  <th className="num">{t('cod.courierFees')}</th>
                  <th className="num">{t('cod.received')}</th>
                </tr>
              </thead>
              <tbody>
                {remittances.data.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{new Date(r.createdAt).toLocaleDateString(locale)}</td>
                    <td>{r.courierCode}</td>
                    <td dir="ltr">{r.reference}</td>
                    <td className="num">{fmt(r.collectedMinor)}</td>
                    <td className="num">{fmt(r.courierFeesMinor)}</td>
                    <td className="num">
                      <strong>{fmt(r.receivedMinor)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

function RemittanceForm({ base, pending, onDone }: { base: string; pending: Summary['pendingRemittance']; onDone: () => void }) {
  const { t, locale } = useI18n();
  const couriers = [...new Set(pending.map((p) => p.courierCode ?? ''))];
  const [courier, setCourier] = useState(couriers[0] ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState({ reference: '', fees: '', received: '' });
  const action = useAction();
  const rows = pending.filter((p) => (p.courierCode ?? '') === (courier || couriers[0]));
  const collected = rows.filter((r) => picked.includes(r.orderId)).reduce((sum, r) => sum + r.amountMinor, 0);
  const fees = form.fees ? money.toMinor(form.fees) : 0;
  const fmt = (v: number) => money.format(v, 'DZD', locale);

  return (
    <Card title={t('cod.pendingRemittance')}>
      {pending.length === 0 ? (
        <p className="muted">{t('cod.nothingWithCouriers')}</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api('POST', `${base}/remittances`, {
                courierCode: courier || couriers[0],
                reference: form.reference.trim(),
                orderIds: picked,
                courierFeesMinor: fees,
                receivedMinor: money.toMinor(form.received || '0'),
              });
              setPicked([]);
              setForm({ reference: '', fees: '', received: '' });
              onDone();
            });
          }}
        >
          <p className="muted small" style={{ margin: 0 }}>
            {t('cod.remittanceHint')}
          </p>
          {couriers.length > 1 && (
            <Field label={t('shipping.courier')}>
              <select value={courier} onChange={(e) => (setCourier(e.target.value), setPicked([]))}>
                {couriers.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId}>
                  <td>
                    <label className="row">
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={picked.includes(r.orderId)}
                        onChange={(e) => setPicked(e.target.checked ? [...picked, r.orderId] : picked.filter((id) => id !== r.orderId))}
                      />
                      <span dir="ltr">{r.number}</span>
                    </label>
                  </td>
                  <td dir="ltr" className="small">
                    {r.courierCode} {r.trackingNumber}
                  </td>
                  <td className="num">{fmt(r.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-grid">
            <Field label={t('cod.courierReference')}>
              <input required minLength={2} maxLength={100} dir="ltr" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </Field>
            <Field label={t('cod.courierFeesDzd')}>
              <input inputMode="decimal" pattern="\d+([.,]\d{1,2})?" value={form.fees} onChange={(e) => setForm({ ...form, fees: e.target.value })} />
            </Field>
            <Field label={t('cod.receivedDzd')} hint={t('cod.expected', { amount: fmt(collected - fees) })}>
              <input required inputMode="decimal" pattern="\d+([.,]\d{1,2})?" value={form.received} onChange={(e) => setForm({ ...form, received: e.target.value })} />
            </Field>
          </div>
          <div>
            <button className="primary" disabled={action.pending || picked.length === 0}>
              {t('cod.recordRemittance')}
            </button>
          </div>
          <ErrorBox error={action.error} />
        </form>
      )}
    </Card>
  );
}
