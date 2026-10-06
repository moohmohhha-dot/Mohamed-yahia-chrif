import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Field, Kv, Loading, Pager, ReasonAction, Tabs, useAction, useLoad } from '../components/ui';
import { useI18n, type Locale } from '../i18n';

const STATUSES = ['under_review', 'requested', 'approved', 'rejected', 'in_transit', 'received', 'inspection_failed', 'refund_pending', 'completed', 'cancelled'] as const;
const PAGE = 50;
const nameIn = (names: Record<string, string>, locale: Locale) => names[locale] ?? names.fr ?? names.ar ?? Object.values(names)[0] ?? '—';

type ReturnRow = { id: string; number: string; status: string; orderNumber: string; customerName: string; reason: string; requestedResolution: string; itemsValueMinor: number; currency: string; createdAt: string };
type ReturnDetail = ReturnRow & {
  paymentMethod: string;
  description: string;
  resolution: string | null;
  returnMethod: string | null;
  approvedAmountMinor: number | null;
  finalAmountMinor: number | null;
  merchantNote: string | null;
  escalationReason: string | null;
  adminNote: string | null;
  finalDecision: boolean;
  inspectionNote: string | null;
  refundReference: string | null;
  lines: { id: string; sku: string; productNames: Record<string, string>; quantity: number; unitPriceMinor: number; restock: boolean | null }[];
  evidence: { id: string; role: string; fileName: string | null }[];
  events: { type: string; toStatus: string | null; actorType: string; actorName: string | null; note: string | null; createdAt: string }[];
};
type Policy = { windowDays: number; merchantResponseHours: number; escalationDays: number; allowChangeOfMind: boolean; changeOfMindFeeMinor: number };

export function ReturnsPage() {
  const { t, label, money, date } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [status, setStatus] = useState<(typeof STATUSES)[number] | ''>('under_review');
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<ReturnRow[]>('GET', `/v1/admin/returns?page=${page}&pageSize=${PAGE}${status ? `&status=${status}` : ''}`), [status, page, selected]);
  if (selected) return <ReturnDetailView returnId={selected} onBack={() => setParams({})} />;
  return (
    <>
      <h1>{t('section.returns')}</h1>
      <Tabs value={status} options={STATUSES} onChange={(v) => (setStatus(v), setPage(1))} prefix="returnStatus" allLabel="common.all" />
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
                <th>{t('returns.number')}</th>
                <th>{t('orders.customer')}</th>
                <th>{t('returns.reason')}</th>
                <th className="num">{t('returns.value')}</th>
                <th>{t('common.status')}</th>
                <th>{t('orders.placed')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td dir="ltr">
                    <button className="link" onClick={() => setParams({ id: r.id })}>
                      {r.number}
                    </button>
                    <div className="muted small">{r.orderNumber}</div>
                  </td>
                  <td>{r.customerName}</td>
                  <td className="small">
                    {label('returnReason', r.reason)} → {label('resolution', r.requestedResolution)}
                  </td>
                  <td className="num">{money(r.itemsValueMinor, r.currency)}</td>
                  <td>
                    <Badge prefix="returnStatus" value={r.status} />
                  </td>
                  <td className="small">{date(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} count={list.data.length} pageSize={PAGE} />
        </Card>
      )}
      {can('returns.policy') && <PolicyCard />}
    </>
  );
}

function ReturnDetailView({ returnId, onBack }: { returnId: string; onBack: () => void }) {
  const { t, label, money, date, locale } = useI18n();
  const { can } = useAuth();
  const url = `/v1/admin/returns/${returnId}`;
  const ret = useLoad(() => api<ReturnDetail>('GET', url), [url]);
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [resolution, setResolution] = useState('');
  const [method, setMethod] = useState('drop_off');
  const [reference, setReference] = useState('');
  if (ret.error) return <ErrorBox error={ret.error} />;
  if (!ret.data) return <Loading />;
  const r = ret.data;
  const fmt = (v: number | null) => (v === null ? '—' : money(v, r.currency));
  const reload = () => void ret.reload();
  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span dir="ltr">{r.number}</span> <Badge prefix="returnStatus" value={r.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('returns.back')}
        </button>
      </div>
      <div className="split">
        <Card title={t('returns.request')}>
          <Kv
            rows={[
              [t('orders.number'), <span dir="ltr">{r.orderNumber}</span>],
              [t('orders.customer'), r.customerName],
              [t('returns.reason'), label('returnReason', r.reason)],
              [t('returns.wants'), label('resolution', r.requestedResolution)],
              [t('returns.description'), r.description],
              [t('returns.value'), fmt(r.itemsValueMinor)],
              [t('returns.final'), fmt(r.finalAmountMinor ?? r.approvedAmountMinor)],
              [t('returns.merchantNote'), r.merchantNote],
              [t('returns.escalation'), r.escalationReason],
              [t('returns.adminNote'), r.adminNote],
              [t('returns.inspection'), r.inspectionNote],
              [t('payments.reference'), r.refundReference],
            ]}
          />
        </Card>
        <Card title={t('orders.lines')}>
          <table>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td>{nameIn(l.productNames, locale)}</td>
                  <td className="num">× {l.quantity}</td>
                  <td className="num">{fmt(l.unitPriceMinor * l.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.evidence.length > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              {r.evidence.map((e, i) => (
                <button key={e.id} onClick={() => void download(`${url}/evidence/${e.id}`, e.fileName ?? `evidence-${i + 1}`)}>
                  {label('actor', e.role)} · {i + 1}
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
      {can('returns.decide') && r.status === 'under_review' && (
        <Card title={t('returns.decide')}>
          <ReasonAction
            label={t('returns.decide')}
            reasonLabel={t('returns.decisionNote')}
            extra={
              <div className="form-grid">
                <Field label={t('returns.decision')}>
                  <select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
                    <option value="approve">{t('returns.approve')}</option>
                    <option value="reject">{t('returns.reject')}</option>
                  </select>
                </Field>
                {decision === 'approve' && (
                  <>
                    <Field label={t('returns.resolution')}>
                      <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                        <option value="">{label('resolution', r.requestedResolution)}</option>
                        {['refund', 'replacement', 'store_credit'].map((x) => (
                          <option key={x} value={x}>
                            {label('resolution', x)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('returns.method')}>
                      <select value={method} onChange={(e) => setMethod(e.target.value)}>
                        {['drop_off', 'pickup', 'keep_item'].map((x) => (
                          <option key={x} value={x}>
                            {label('returnMethod', x)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}
              </div>
            }
            onConfirm={(note) => api('POST', `${url}/decision`, { decision, note, ...(decision === 'approve' ? { returnMethod: method, ...(resolution ? { resolution } : {}) } : {}) }).then(reload)}
          />
        </Card>
      )}
      {can('refunds.execute') && r.status === 'refund_pending' && (
        <Card title={t('returns.refund')}>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void api('POST', `${url}/refund`, reference.trim() ? { externalReference: reference.trim() } : {}).then(reload);
            }}
          >
            {r.paymentMethod === 'cash_on_delivery' && <input required placeholder={t('orders.transferReference')} aria-label={t('orders.transferReference')} value={reference} onChange={(e) => setReference(e.target.value)} style={{ maxWidth: 260 }} />}
            <button className="primary">{r.paymentMethod === 'cash_on_delivery' ? t('returns.recordTransfer') : t('returns.sendRefund', { amount: fmt(r.finalAmountMinor) })}</button>
          </form>
        </Card>
      )}
      <Card title={t('orders.history')}>
        <table>
          <tbody>
            {r.events.map((e, i) => (
              <tr key={i}>
                <td className="small">{date(e.createdAt)}</td>
                <td className="small">
                  {label('returnEvent', e.type)} {e.toStatus && <Badge prefix="returnStatus" value={e.toStatus} />}
                </td>
                <td className="small">{e.actorName ?? label('actor', e.actorType)}</td>
                <td className="small muted">{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function PolicyCard() {
  const { t } = useI18n();
  const policy = useLoad(() => api<Policy>('GET', '/v1/admin/returns-policy'), []);
  const [form, setForm] = useState<Policy | null>(null);
  const action = useAction();
  const p = form ?? policy.data;
  if (!p) return null;
  const set = (k: keyof Policy, v: number | boolean) => setForm({ ...p, [k]: v });
  return (
    <Card title={t('returns.policy')}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() => api('PUT', '/v1/admin/returns-policy', p).then(() => policy.reload()));
        }}
      >
        <Field label={t('returns.windowDays')}>
          <input type="number" min={1} max={90} value={p.windowDays} onChange={(e) => set('windowDays', Number(e.target.value))} />
        </Field>
        <Field label={t('returns.responseHours')}>
          <input type="number" min={1} max={720} value={p.merchantResponseHours} onChange={(e) => set('merchantResponseHours', Number(e.target.value))} />
        </Field>
        <Field label={t('returns.escalationDays')}>
          <input type="number" min={1} max={60} value={p.escalationDays} onChange={(e) => set('escalationDays', Number(e.target.value))} />
        </Field>
        <Field label={t('returns.changeOfMind')}>
          <select value={String(p.allowChangeOfMind)} onChange={(e) => set('allowChangeOfMind', e.target.value === 'true')}>
            <option value="true">{t('common.yes')}</option>
            <option value="false">{t('common.no')}</option>
          </select>
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <button className="primary" disabled={action.pending}>
            {t('common.save')}
          </button>
        </div>
      </form>
      <ErrorBox error={action.error} />
      {action.done && <p className="small" role="status">{t('common.saved')}</p>}
    </Card>
  );
}
