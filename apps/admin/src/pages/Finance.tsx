import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Field, Json, Loading, Pager, ReasonAction, Tabs, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const PAGE = 50;
type TrialBalance = {
  currencies: { currency: string; debitsMinor: number; creditsMinor: number; balanced: boolean }[];
  platformAccounts: { purpose: string; type: string; currency: string; balanceMinor: number }[];
  merchantTotals: { currency: string; purpose: string; balanceMinor: number }[];
};
type Run = { id: string; balanced: boolean; periodFrom: string; periodTo: string; summary: Record<string, unknown>; discrepancies: Record<string, unknown>[]; createdAt: string };
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The double-entry ledger, read-only: balances, reconciliation with the Payment Service, provider settlements. */
export function FinancePage() {
  const { t, label, money, date } = useI18n();
  const { can } = useAuth();
  const tb = useLoad(() => api<TrialBalance>('GET', '/v1/admin/finance/trial-balance'), []);
  const runs = useLoad(() => api<Run[]>('GET', '/v1/admin/finance/reconciliation'), []);
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 7 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date(Date.now() + 86400_000)));
  const [provider, setProvider] = useState({ provider: '', reference: '', currency: 'DZD', gross: '', fees: '' });
  const action = useAction();
  const [released, setReleased] = useState<number | null>(null);

  return (
    <>
      <h1>{t('section.finance')}</h1>
      <p className="muted">{t('finance.intro')}</p>
      <ErrorBox error={tb.error} />
      {tb.data && (
        <>
          <div className="grid">
            {tb.data.currencies.map((c) => (
              <div className="stat" key={c.currency} data-testid={`balanced-${c.currency}`}>
                <div className="muted small">{t('finance.ledger', { currency: c.currency })}</div>
                <div className="value" style={{ fontSize: '1.2rem' }}>
                  {money(c.debitsMinor, c.currency)}
                </div>
                <Badge prefix="finance" value={c.balanced ? 'balanced' : 'unbalanced'} />
              </div>
            ))}
          </div>
          <div className="split">
            <Card title={t('finance.platformAccounts')}>
              <table>
                <tbody>
                  {tb.data.platformAccounts.map((a) => (
                    <tr key={a.purpose + a.currency}>
                      <td>{label('account', a.purpose)}</td>
                      <td className="num">{money(a.balanceMinor, a.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title={t('finance.merchantTotals')}>
              <table>
                <tbody>
                  {tb.data.merchantTotals.map((a) => (
                    <tr key={a.purpose + a.currency}>
                      <td>{label('account', a.purpose)}</td>
                      <td className="num">{money(Math.abs(a.balanceMinor), a.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
      <Card
        title={t('finance.reconciliation')}
        actions={
          can('finance.manage') && (
            <form className="row" onSubmit={(e) => (e.preventDefault(), void action.run(() => api('POST', '/v1/admin/finance/reconciliation', { from: new Date(from).toISOString(), to: new Date(to).toISOString() }).then(() => runs.reload())))}>
              <input type="date" aria-label={t('finance.from')} value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
              <input type="date" aria-label={t('finance.to')} value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
              <button className="primary" disabled={action.pending}>
                {t('finance.runReconciliation')}
              </button>
            </form>
          )
        }
      >
        <ErrorBox error={action.error} />
        {!runs.data || runs.data.length === 0 ? (
          <Empty />
        ) : (
          <table>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td className="small">{date(r.createdAt)}</td>
                  <td className="small">
                    {date(r.periodFrom, false)} → {date(r.periodTo, false)}
                  </td>
                  <td>
                    <Badge prefix="finance" value={r.balanced ? 'balanced' : 'unbalanced'} />
                  </td>
                  <td style={{ maxWidth: 420 }}>{r.discrepancies.length ? <Json value={r.discrepancies} /> : <span className="muted small">{t('finance.noDiscrepancy')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {can('finance.manage') && (
        <div className="split">
          <Card title={t('finance.release')}>
            <p className="muted small">{t('finance.releaseHint')}</p>
            <button onClick={() => void action.run(async () => setReleased((await api<{ released: number }>('POST', '/v1/admin/finance/release')).released))}>{t('finance.releaseNow')}</button>
            {released !== null && <p className="small">{t('finance.released', { n: released })}</p>}
          </Card>
          <Card title={t('finance.providerSettlement')}>
            <form
              className="form-grid"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(() =>
                  api('POST', '/v1/admin/finance/provider-settlements', {
                    provider: provider.provider.trim(),
                    reference: provider.reference.trim(),
                    currency: provider.currency,
                    grossMinor: Math.round(Number(provider.gross) * 100),
                    feesMinor: Math.round(Number(provider.fees || 0) * 100),
                  }).then(() => tb.reload()),
                );
              }}
            >
              <Field label={t('finance.provider')}>
                <input required value={provider.provider} onChange={(e) => setProvider({ ...provider, provider: e.target.value })} />
              </Field>
              <Field label={t('payments.reference')}>
                <input required value={provider.reference} onChange={(e) => setProvider({ ...provider, reference: e.target.value })} />
              </Field>
              <Field label={t('finance.gross')}>
                <input required inputMode="decimal" value={provider.gross} onChange={(e) => setProvider({ ...provider, gross: e.target.value })} />
              </Field>
              <Field label={t('finance.fees')}>
                <input inputMode="decimal" value={provider.fees} onChange={(e) => setProvider({ ...provider, fees: e.target.value })} />
              </Field>
              <div style={{ alignSelf: 'end' }}>
                <button className="primary">{t('common.save')}</button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </>
  );
}

type Rules = {
  current: { platformCommissionBps: number; holdDays: number; orderFeeMinor: number };
  commissionRules: { id: string; scope: string; storeId: string | null; bps: number; effectiveFrom: string; reason: string; createdAt: string }[];
  settings: { id: string; key: string; value: number; effectiveFrom: string; reason: string }[];
};
type Store = { id: string; slug: string; name: string };

/** ARUMA's commission and finance settings: new rules take effect from a date; past orders keep their rate. */
export function CommissionPage() {
  const { t, label, date } = useI18n();
  const { can } = useAuth();
  const rules = useLoad(() => api<Rules>('GET', '/v1/admin/finance/rules'), []);
  const stores = useLoad(() => api<Store[]>('GET', '/v1/admin/stores'), []);
  const [rule, setRule] = useState({ storeId: '', percent: '', from: '' });
  const [setting, setSetting] = useState({ key: 'hold_days', value: '', from: '' });
  const storeName = (id: string | null) => (id ? stores.data?.find((s) => s.id === id)?.name ?? id : t('commission.platform'));
  if (rules.error) return <ErrorBox error={rules.error} />;
  if (!rules.data) return <Loading />;
  const r = rules.data;
  return (
    <>
      <h1>{t('section.commission')}</h1>
      <div className="grid">
        <div className="stat">
          <div className="muted small">{t('commission.platformRate')}</div>
          <div className="value" data-testid="platform-rate">
            {r.current.platformCommissionBps / 100} %
          </div>
        </div>
        <div className="stat">
          <div className="muted small">{t('commission.holdDays')}</div>
          <div className="value">{r.current.holdDays}</div>
        </div>
        <div className="stat">
          <div className="muted small">{t('commission.orderFee')}</div>
          <div className="value">{r.current.orderFeeMinor / 100}</div>
        </div>
      </div>
      <Card title={t('commission.rules')}>
        <table>
          <tbody>
            {r.commissionRules.map((c) => (
              <tr key={c.id}>
                <td>{storeName(c.storeId)}</td>
                <td className="num">{c.bps / 100} %</td>
                <td className="small">{t('commission.from', { date: date(c.effectiveFrom) })}</td>
                <td className="small muted">{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {can('commission.manage') && (
          <ReasonAction
            label={t('commission.addRule')}
            extra={
              <div className="form-grid">
                <Field label={t('products.store')}>
                  <select value={rule.storeId} onChange={(e) => setRule({ ...rule, storeId: e.target.value })}>
                    <option value="">{t('commission.platform')}</option>
                    {stores.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('commission.percent')}>
                  <input required inputMode="decimal" value={rule.percent} onChange={(e) => setRule({ ...rule, percent: e.target.value })} />
                </Field>
                <Field label={t('commission.effectiveFrom')} hint={t('commission.futureHint')}>
                  <input required type="datetime-local" value={rule.from} onChange={(e) => setRule({ ...rule, from: e.target.value })} />
                </Field>
              </div>
            }
            onConfirm={(reason) =>
              api('POST', '/v1/admin/finance/commission-rules', {
                ...(rule.storeId ? { storeId: rule.storeId } : {}),
                bps: Math.round(Number(rule.percent.replace(',', '.')) * 100),
                effectiveFrom: new Date(rule.from).toISOString(),
                reason,
              }).then(() => rules.reload())
            }
          />
        )}
        <p className="muted small">{t('commission.merchantHint')}</p>
      </Card>
      <Card title={t('commission.settings')}>
        <table>
          <tbody>
            {r.settings.map((s) => (
              <tr key={s.id}>
                <td>{label('setting', s.key)}</td>
                <td className="num">{s.value}</td>
                <td className="small">{t('commission.from', { date: date(s.effectiveFrom) })}</td>
                <td className="small muted">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {can('finance.manage') && (
          <ReasonAction
            label={t('commission.addSetting')}
            extra={
              <div className="form-grid">
                <Field label={t('commission.setting')}>
                  <select value={setting.key} onChange={(e) => setSetting({ ...setting, key: e.target.value })}>
                    <option value="hold_days">{label('setting', 'hold_days')}</option>
                    <option value="order_fee_minor">{label('setting', 'order_fee_minor')}</option>
                  </select>
                </Field>
                <Field label={t('commission.value')}>
                  <input required type="number" min={0} value={setting.value} onChange={(e) => setSetting({ ...setting, value: e.target.value })} />
                </Field>
                <Field label={t('commission.effectiveFrom')}>
                  <input required type="datetime-local" value={setting.from} onChange={(e) => setSetting({ ...setting, from: e.target.value })} />
                </Field>
              </div>
            }
            onConfirm={(reason) => api('POST', '/v1/admin/finance/settings', { key: setting.key, value: Number(setting.value), effectiveFrom: new Date(setting.from).toISOString(), reason }).then(() => rules.reload())}
          />
        )}
      </Card>
    </>
  );
}

type Settlement = { id: string; number: string; merchantId: string; merchantName: string; currency: string; amountMinor: number; periodEnd: string; breakdown: Record<string, number>; payoutStatus: string | null; createdAt: string };

export function SettlementsPage() {
  const { t, money, date } = useI18n();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<Settlement[]>('GET', `/v1/admin/finance/settlements?page=${page}&pageSize=${PAGE}`), [page]);
  const [merchantId, setMerchantId] = useState('');
  const merchants = useLoad(() => (can('finance.manage') ? api<{ id: string; name: string }[]>('GET', '/v1/admin/merchants?verificationStatus=verified&pageSize=100') : Promise.resolve([])), []);
  const action = useAction();
  return (
    <>
      <h1>{t('section.settlements')}</h1>
      <p className="muted">{t('settlements.intro')}</p>
      {can('finance.manage') && (
        <Card title={t('settlements.create')}>
          <form className="row" onSubmit={(e) => (e.preventDefault(), void action.run(() => api('POST', '/v1/admin/finance/settlements', { merchantId, currency: 'DZD' }).then(() => list.reload())))}>
            <select required aria-label={t('products.merchant')} value={merchantId} onChange={(e) => setMerchantId(e.target.value)} style={{ maxWidth: 380 }}>
              <option value="" />
              {merchants.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <button className="primary" disabled={action.pending}>
              {t('settlements.settle')}
            </button>
          </form>
          <ErrorBox error={action.error} />
        </Card>
      )}
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
                <th>{t('settlements.number')}</th>
                <th>{t('products.merchant')}</th>
                <th className="num">{t('payments.amount')}</th>
                <th>{t('settlements.payout')}</th>
                <th>{t('orders.placed')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td dir="ltr">{s.number}</td>
                  <td>{s.merchantName}</td>
                  <td className="num">{money(s.amountMinor, s.currency)}</td>
                  <td>
                    <Badge prefix="payoutStatus" value={s.payoutStatus} />
                  </td>
                  <td className="small">{date(s.createdAt)}</td>
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

type Payout = { id: string; merchantId: string; amountMinor: number; currency: string; status: string; destination: Record<string, string>; externalReference: string | null; failureReason: string | null; createdAt: string; paidAt: string | null };
const PAYOUT_STATUSES = ['requested', 'sent', 'paid', 'failed'] as const;

/** Transfers to merchants. ARUMA makes the transfer at the bank or Algérie Poste, then records it here with its reference. */
export function PayoutsPage() {
  const { t, label, money, date } = useI18n();
  const { can } = useAuth();
  const [status, setStatus] = useState<(typeof PAYOUT_STATUSES)[number] | ''>('requested');
  const list = useLoad(() => api<Payout[]>('GET', `/v1/admin/finance/payouts${status ? `?status=${status}` : ''}`), [status]);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const action = useAction();
  const update = (id: string, body: object) => action.run(() => api('POST', `/v1/admin/finance/payouts/${id}/status`, body).then(() => list.reload()));
  return (
    <>
      <h1>{t('section.payouts')}</h1>
      <p className="muted">{t('payouts.intro')}</p>
      <Tabs value={status} options={PAYOUT_STATUSES} onChange={setStatus} prefix="payoutStatus" allLabel="common.all" />
      <ErrorBox error={list.error ?? action.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <table>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{money(p.amountMinor, p.currency)}</strong>
                    <div className="muted small">
                      {label('payoutType', p.destination.type)} · {p.destination.holderName} · ••••{p.destination.last4}
                    </div>
                  </td>
                  <td>
                    <Badge prefix="payoutStatus" value={p.status} />
                    <div className="muted small">{p.externalReference ?? p.failureReason}</div>
                  </td>
                  <td className="small">{date(p.createdAt)}</td>
                  <td>
                    {can('payouts.manage') && (p.status === 'requested' || p.status === 'sent') && (
                      <div className="row">
                        {p.status === 'requested' && <button onClick={() => void update(p.id, { status: 'sent' })}>{t('payouts.markSent')}</button>}
                        <input placeholder={t('payouts.bankReference')} aria-label={t('payouts.bankReference')} value={refs[p.id] ?? ''} onChange={(e) => setRefs({ ...refs, [p.id]: e.target.value })} style={{ width: 160 }} />
                        <button className="primary" disabled={!refs[p.id]?.trim()} onClick={() => void update(p.id, { status: 'paid', externalReference: refs[p.id]!.trim() })}>
                          {t('payouts.markPaid')}
                        </button>
                        <ReasonAction label={t('payouts.markFailed')} danger onConfirm={(reason) => update(p.id, { status: 'failed', reason })} />
                      </div>
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
